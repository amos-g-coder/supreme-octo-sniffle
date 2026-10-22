#if os(macOS)
  import AppKit
  import InflexClient

  actor RuntimeOwner {
    private var process: Process?
    private var log: FileHandle?
    private var stopping = false

    func start(client: RuntimeClient, external: Bool) async throws {
      if (try? await client.send(path: "inflex/diagnostics", timeout: 1)) != nil { return }
      if external { throw ClientError.disconnected }
      guard let resources = Bundle.main.resourceURL else { throw LaunchError.resources }
      let runtime = resources.appendingPathComponent("runtime")
      let node = runtime.appendingPathComponent("node")
      guard FileManager.default.isExecutableFile(atPath: node.path) else {
        throw LaunchError.resources
      }
      guard !stopping else { throw CancellationError() }
      if let process, process.isRunning {
        throw LaunchError.timeout("~/Library/Application Support/Inflex/desktop-runtime.log")
      }
      let child = Process()
      child.executableURL = node
      child.arguments = [runtime.appendingPathComponent("server/dist/cli.js").path, "serve"]
      var environment = ProcessInfo.processInfo.environment
      environment["HOST"] = "127.0.0.1"
      environment["PORT"] = String(client.baseURL.port ?? 8790)
      environment["STANDALONE"] = "true"
      environment["NODE_ENV"] = "production"
      environment["INFLEX_WORKSPACE"] =
        environment["INFLEX_WORKSPACE"] ?? FileManager.default.homeDirectoryForCurrentUser.path
      environment["INFLEX_KEYCHAIN_HELPER"] =
        runtime.appendingPathComponent("native/bin/inflex-keychain").path
      environment["INFLEX_MEDIA_WORKER"] = runtime.appendingPathComponent("media/worker.mjs").path
      child.environment = environment
      child.currentDirectoryURL = URL(
        fileURLWithPath: environment["INFLEX_WORKSPACE"] ?? NSHomeDirectory())
      let directory = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask,
        appropriateFor: nil, create: true
      ).appendingPathComponent("Inflex")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let logURL = directory.appendingPathComponent("desktop-runtime.log")
      // Truncate between launches; a desktop session does not accumulate unbounded startup logs.
      try Data().write(to: logURL)
      let handle = try FileHandle(forWritingTo: logURL)
      child.standardOutput = handle
      child.standardError = handle
      child.standardInput = FileHandle.nullDevice
      do {
        try child.run()
        process = child
        log = handle
        for _ in 0..<180 {
          try Task.checkCancellation()
          if stopping { throw CancellationError() }
          if !child.isRunning { throw LaunchError.exited(logURL.path) }
          if (try? await client.send(path: "inflex/diagnostics", timeout: 1)) != nil { return }
          try await Task.sleep(for: .milliseconds(250))
        }
        throw LaunchError.timeout(logURL.path)
      } catch {
        await terminateOwnedProcess()
        throw error
      }
    }

    func stop() async {
      stopping = true
      await terminateOwnedProcess()
    }
    private func terminateOwnedProcess() async {
      guard let child = process else { return }
      if child.isRunning {
        child.terminate()
        for _ in 0..<100 {
          if !child.isRunning { break }
          try? await Task.sleep(for: .milliseconds(100))
        }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
      }
      try? log?.close()
      log = nil
      process = nil
    }
  }

  private enum LaunchError: LocalizedError {
    case resources
    case exited(String)
    case timeout(String)
    var errorDescription: String? {
      switch self {
      case .resources:
        return
          "The bundled runtime is missing. Build Inflex with pnpm inflex:desktop:prepare and pnpm inflex:desktop:build, or start the runtime in Terminal."
      case .exited(let path): return "The runtime stopped during startup. See \(path)."
      case .timeout(let path): return "The runtime did not become ready. See \(path)."
      }
    }
  }
#endif
