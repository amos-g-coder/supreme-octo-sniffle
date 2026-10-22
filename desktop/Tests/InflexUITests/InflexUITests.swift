import XCTest

@MainActor final class InflexUITests: XCTestCase {
  private var app: XCUIApplication!
  override func setUp() async throws {
    continueAfterFailure = false
    try await reset(authenticated: true)
    app = XCUIApplication(bundleIdentifier: "dev.inflex.desktop")
    app.launchArguments = ["--runtime-url", "http://127.0.0.1:18790"]
  }
  override func tearDown() { app.terminate() }

  func testChatModesStreamingHistoryAndConfiguration() {
    launchReady()
    let goal = app.popUpButtons["goal-mode"]
    for mode in ["Enhanced", "Advanced", "Standard"] {
      goal.click()
      app.menuItems[mode].click()
    }
    let thinking = app.popUpButtons["thinking-tier"]
    for tier in ["Light", "Deep", "Intensive", "Ultra", "Balanced"] {
      thinking.click()
      app.menuItems[tier].click()
    }
    send("Review this engineering change")
    XCTAssertTrue(app.staticTexts["Native SwiftUI response — ready."].waitForExistence(timeout: 10))
    app.buttons["nav-New Chat"].click()
    XCTAssertTrue(app.staticTexts["How can I help you today?"].exists)
    app.buttons.matching(identifier: "session-session-1").firstMatch.click()
    XCTAssertTrue(app.staticTexts["Native SwiftUI response — ready."].waitForExistence(timeout: 10))
    app.buttons["agent-configuration"].click()
    XCTAssertTrue(app.staticTexts["Agent Configuration"].exists)
    screenshot("chat-light")
  }
  func testApprovalAndMedia() {
    launchReady()
    send("approval")
    XCTAssertTrue(app.buttons["approve-call-1"].waitForExistence(timeout: 10))
    screenshot("approval")
    app.buttons["approve-call-1"].click()
    XCTAssertTrue(app.staticTexts["Approved and completed."].waitForExistence(timeout: 10))
    app.buttons["media"].click()
    XCTAssertTrue(app.staticTexts["evidence.json"].waitForExistence(timeout: 5))
    app.buttons["Preview"].click()
    XCTAssertTrue(app.buttons["Save…"].waitForExistence(timeout: 10))
    screenshot("media")
    app.buttons["Done"].click()
  }
  func testSettingsLibraryAndDarkAppearance() {
    launchReady()
    for name in ["Agents", "Sessions", "Schedules", "Environments", "Settings"] {
      app.buttons["nav-\(name)"].click()
      XCTAssertTrue(app.staticTexts[name].firstMatch.waitForExistence(timeout: 5))
    }
    let theme = app.popUpButtons["Theme"]
    theme.click()
    app.menuItems["Dark"].click()
    screenshot("settings-dark")
    theme.click()
    app.menuItems["Light"].click()
    app.buttons["Connectors"].click()
    XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
    app.buttons["Add"].click()
    XCTAssertTrue(app.buttons["Save"].exists)
    screenshot("connector-editor")
    app.buttons["Cancel"].click()
  }
  func testStopAndEditEarlierMessage() {
    launchReady()
    send("wait for stop")
    XCTAssertTrue(app.buttons["stop"].waitForExistence(timeout: 5))
    app.buttons["stop"].click()
    XCTAssertTrue(app.staticTexts["Cancelled: client-cancelled"].waitForExistence(timeout: 10))
    app.buttons["Edit"].firstMatch.click()
    XCTAssertTrue(app.staticTexts["Editing earlier message"].exists)
    app.buttons["Cancel edit"].click()
    XCTAssertFalse(app.staticTexts["Editing earlier message"].exists)
  }
  func testSignInScreen() async throws {
    try await reset(authenticated: false)
    app.launch()
    XCTAssertTrue(app.buttons["sign-in"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["reload-sign-in"].exists)
    screenshot("sign-in")
  }
  func testNativeLaunchAndResourceMetrics() {
    measure(metrics: [
      XCTApplicationLaunchMetric(), XCTMemoryMetric(application: app),
      XCTCPUMetric(application: app),
    ]) {
      app.launch()
      XCTAssertTrue(app.buttons["nav-New Chat"].waitForExistence(timeout: 10))
      app.terminate()
    }
  }
  private func launchReady() {
    app.launch()
    XCTAssertTrue(app.buttons["nav-New Chat"].waitForExistence(timeout: 10))
    XCTAssertGreaterThanOrEqual(app.windows.firstMatch.frame.width, 960)
  }
  private func send(_ text: String) {
    let composer = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    composer.click()
    composer.typeText(text)
    app.buttons["send"].click()
  }
  private func screenshot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  private func reset(authenticated: Bool) async throws {
    guard let url = URL(string: "http://127.0.0.1:18790/__test/reset") else {
      throw URLError(.badURL)
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = try JSONSerialization.data(withJSONObject: ["authenticated": authenticated])
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
  }
}
