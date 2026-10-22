#if os(macOS)
  import AppKit
  import SwiftUI
  import InflexClient
  import MarkdownUI

  struct MessageView: View {
    let model: AppModel
    let item: TranscriptItem
    @State private var response = ""
    @State private var approved = false
    var body: some View {
      Group {
        switch item.kind {
        case "user":
          VStack(alignment: .trailing, spacing: 6) {
            HStack {
              Spacer(minLength: 48)
              MarkdownContent(text: item.text).padding(14).background(
                Brand.sidebar, in: RoundedRectangle(cornerRadius: 14))
            }
            if !model.transcript.isLive {
              Button("Edit") { model.edit(item) }.buttonStyle(.borderless).font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        case "assistant":
          if !item.text.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Label(item.title, systemImage: item.thread == "main" ? "sparkle" : "person.2").font(
                .caption.bold()
              ).foregroundStyle(.secondary)
              if let reasoning = item.detail["reasoning_content"].string, !reasoning.isEmpty {
                DisclosureGroup("Thinking") { MarkdownContent(text: reasoning) }.font(.caption)
                  .foregroundStyle(.secondary)
              }
              MarkdownContent(text: item.text)
              HStack {
                Button {
                  NSPasteboard.general.clearContents()
                  NSPasteboard.general.setString(item.text, forType: .string)
                } label: {
                  Image(systemName: "doc.on.doc")
                }.help("Copy")
                if !model.transcript.isLive {
                  Button("Retry") {
                    model.edit(item)
                    Task { await model.send() }
                  }
                }
              }.buttonStyle(.borderless).font(.caption).foregroundStyle(.secondary)
            }
          }
        case "tool":
          DisclosureGroup {
            Text(item.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            if item.detail["response"] != .null {
              Divider()
              MarkdownContent(text: item.detail["response"].text)
            }
          } label: {
            Label(item.title, systemImage: "terminal").font(.callout)
          }.padding(12)
            .background(Brand.sidebar.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
        case "thread":
          DisclosureGroup {
            Text(item.text).textSelection(.enabled)
            Text(item.detail.formatted()).font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
          } label: {
            HStack {
              Label(item.title, systemImage: "person.2")
              Spacer()
              Text(item.pending ? "Working" : "Complete").font(.caption).foregroundStyle(.secondary)
            }
          }.padding(12).background(
            Brand.purple.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        case "tool.approval_required", "tool.response_required":
          if item.pending {
            VStack(alignment: .leading, spacing: 12) {
              Label(
                item.kind == "tool.approval_required"
                  ? "Approval required: \(item.title)" : item.title, systemImage: "hand.raised"
              )
              .font(.headline)
              Text(item.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
              if item.kind == "tool.approval_required" {
                HStack {
                  Button("Allow") { respond(allow: true) }.buttonStyle(PrimaryButton())
                    .accessibilityIdentifier("approve-\(item.detail["tool_call_id"].string ?? "")")
                  Button("Deny") { respond(allow: false) }.accessibilityIdentifier(
                    "deny-\(item.detail["tool_call_id"].string ?? "")")
                  if item.detail["tool"]["tool_info"]["type"].string == "mcp" {
                    Button("Allow for session") { respond(allow: true, always: true) }
                  }
                }.disabled(approved)
              } else {
                TextField("Your response", text: $response, axis: .vertical).textFieldStyle(
                  .roundedBorder)
                Button("Continue") {
                  approved = true
                  Task {
                    await model.respond(item, content: response)
                    approved = false
                  }
                }.disabled(response.isEmpty || approved)
              }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
              .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Brand.purple.opacity(0.5)))
          }
        case "mcp.auth_required":
          if item.pending {
            VStack(alignment: .leading, spacing: 12) {
              Text(item.title).font(.headline)
              ForEach(item.detail["mcp_servers"].array, id: \.recordID) { server in
                if let text = server["auth_url"].string, let url = URL(string: text),
                  ["http", "https"].contains(url.scheme ?? "")
                {
                  Link("Sign in to \(server["name"].string ?? "account")", destination: url)
                }
              }
              Button("Continue after sign-in") { Task { await model.respond(item) } }
            }.padding(12)
          }
        default:
          Label("\(item.title): \(item.text)", systemImage: "info.circle").font(.callout)
            .foregroundStyle(.secondary)
        }
      }.accessibilityIdentifier("message-\(item.id)")
    }
    private func respond(allow: Bool, always: Bool = false) {
      approved = true
      Task {
        await model.respond(item, allow: allow, always: always)
        approved = false
      }
    }
  }

  struct MarkdownContent: View {
    let text: String
    var body: some View {
      Markdown(text)
        .markdownTheme(.gitHub)
        .markdownTextStyle { FontSize(14) }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
#endif
