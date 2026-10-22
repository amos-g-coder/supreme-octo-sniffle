import Foundation
import Security

struct Request: Decodable { let operation: String; let value: String? }
let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.inflex.chatgpt", kSecAttrAccount as String: "local-owner"]
switch request.operation {
case "read":
    var read = query
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(read as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data { FileHandle.standardOutput.write(data) }
    else if status != errSecItemNotFound { exit(1) }
case "write":
    guard let value = request.value, let data = value.data(using: .utf8) else { exit(1) }
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if SecItemAdd(add as CFDictionary, nil) != errSecSuccess { exit(1) }
    } else if status != errSecSuccess { exit(1) }
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
default: exit(1)
}
