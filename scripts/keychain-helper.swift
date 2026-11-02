import Foundation
import Security

// Credentials enter over stdin and leave only over the parent's private pipe.
// Never pass them in command arguments or log them. Items stay in login Keychain.
SecKeychainSetUserInteractionAllowed(false)
func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 65536,
      let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let action = request["action"] as? String,
      let service = request["service"] as? String, service.hasPrefix("dev.codex-model-bridge."),
      let account = request["account"] as? String, ["openai", "deepseek", "fixture"].contains(account) else {
    reply(["ok": false, "status": Int(errSecParam)]); exit(1)
}
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                           kSecAttrService as String: service, kSecAttrAccount as String: account]
var status: OSStatus = errSecParam
switch action {
case "get":
    var read = query
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    status = SecItemCopyMatching(read as CFDictionary, &result)
    if status == errSecItemNotFound { reply(["ok": true, "value": NSNull()]); exit(0) }
    if status == errSecSuccess, let data = result as? Data,
       let value = try? JSONSerialization.jsonObject(with: data) {
        reply(["ok": true, "value": value]); exit(0)
    }
case "save":
    if let value = request["value"] as? [String: Any],
       let key = value["key"] as? String, key.count >= 8, key.count <= 8192,
       let data = try? JSONSerialization.data(withJSONObject: value) {
        status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = "Codex Model Bridge · " + account
            add[kSecAttrSynchronizable as String] = false
            status = SecItemAdd(add as CFDictionary, nil)
        }
    }
case "delete":
    status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { status = errSecSuccess }
default: break
}
reply(["ok": status == errSecSuccess, "status": Int(status)])
exit(status == errSecSuccess ? 0 : 1)
