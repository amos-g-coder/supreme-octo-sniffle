import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public final class RuntimeClient: @unchecked Sendable {
  public let baseURL: URL
  private let credential: String
  private let session: URLSession
  public init(
    baseURL: URL, credential: String = "trueforge-standalone", session: URLSession = .shared
  ) throws {
    guard baseURL.scheme == "http",
      ["127.0.0.1", "localhost", "[::1]", "::1"].contains(baseURL.host ?? ""),
      baseURL.user == nil, baseURL.password == nil, baseURL.query == nil, baseURL.fragment == nil
    else {
      throw ClientError.invalidURL
    }
    self.baseURL = baseURL
    self.credential = credential
    self.session = session
  }
  public func url(path: String, query: [String: String] = [:]) throws -> URL {
    guard !path.contains("://"), !path.hasPrefix("//") else { throw ClientError.invalidURL }
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw ClientError.invalidURL
    }
    components.percentEncodedPath =
      "/api/v1/" + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if !query.isEmpty {
      components.queryItems = query.sorted { $0.key < $1.key }.map {
        URLQueryItem(name: $0.key, value: $0.value)
      }
    }
    guard let url = components.url else { throw ClientError.invalidURL }
    return url
  }
  public static func segment(_ value: String) -> String {
    value.addingPercentEncoding(
      withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? ""
  }
  private func request(path: String, method: String, body: JSON?, query: [String: String]) throws
    -> URLRequest
  {
    var request = URLRequest(url: try url(path: path, query: query))
    request.httpMethod = method
    request.timeoutInterval = 60
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = try JSONEncoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }
  public func send(
    path: String, method: String = "GET", body: JSON? = nil, query: [String: String] = [:],
    timeout: TimeInterval = 60
  ) async throws -> JSON {
    var request = try request(path: path, method: method, body: body, query: query)
    request.timeoutInterval = timeout
    let (data, response) = try await session.data(for: request)
    try Self.check(response: response, data: data)
    return data.isEmpty ? .null : try JSONDecoder().decode(JSON.self, from: data)
  }
  public func downloadArtifact(id: String, name: String) async throws -> URL {
    let request = try request(
      path: "inflex/artifacts/\(Self.segment(id))", method: "GET", body: nil, query: [:])
    let (temporary, response) = try await session.download(for: request)
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw ClientError.response(http.statusCode, "Artifact unavailable")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "inflex-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent(URL(fileURLWithPath: name).lastPathComponent)
    try FileManager.default.moveItem(at: temporary, to: target)
    return target
  }
  public func stream(
    path: String, method: String = "POST", body: JSON? = nil, query: [String: String] = [:]
  ) throws -> AsyncThrowingStream<StreamEvent, Error> {
    var request = try request(path: path, method: method, body: body, query: query)
    request.timeoutInterval = 24 * 60 * 60
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(1024)) { continuation in
      let delegate = StreamDelegate(continuation: continuation)
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 24 * 60 * 60
      configuration.urlCache = nil
      let streaming = URLSession(
        configuration: configuration, delegate: delegate, delegateQueue: nil)
      continuation.onTermination = { @Sendable _ in streaming.invalidateAndCancel() }
      streaming.dataTask(with: request).resume()
    }
  }
  static func check(response: URLResponse, data: Data) throws {
    guard let http = response as? HTTPURLResponse else { throw ClientError.malformedStream }
    guard (200..<300).contains(http.statusCode) else {
      throw ClientError.response(
        http.statusCode, String(decoding: data.prefix(4096), as: UTF8.self))
    }
  }
}

private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation
  private var decoder = SSEDecoder()
  init(continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation) {
    self.continuation = continuation
  }
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    do {
      try RuntimeClient.check(response: response, data: Data())
      guard response.mimeType == "text/event-stream" else { throw ClientError.malformedStream }
      completionHandler(.allow)
    } catch {
      continuation.finish(throwing: error)
      completionHandler(.cancel)
    }
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do {
      for event in try decoder.append(data) {
        if case .dropped = continuation.yield(event) {
          continuation.finish(throwing: ClientError.disconnected)
          session.invalidateAndCancel()
          return
        }
      }
    } catch {
      continuation.finish(throwing: error)
      session.invalidateAndCancel()
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error { continuation.finish(throwing: error) } else { continuation.finish() }
    session.finishTasksAndInvalidate()
  }
}
