import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear the app icon badge. Every turn notification ships badge: 1 (see api/notify.js),
        // and nothing else resets it — there's no badge plugin, and the in-app games badge is a
        // DOM element, not the icon. Without this the red 1 sticks permanently once a push has
        // arrived, no matter how many times the app is opened.
        clearIconBadge(application)
        // Deferred deep link: on the very first launch (e.g. installed from a
        // challenge link), recover the game code the web prompt stashed on the
        // clipboard, since iOS doesn't pass the original link to a fresh install.
        checkDeferredInvite()
        // Disable native scroll-view bouncing so the fixed header/footer can't be dragged
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if let bridge = (self.window?.rootViewController as? CAPBridgeViewController)?.bridge {
                bridge.webView?.scrollView.bounces = false
                bridge.webView?.scrollView.alwaysBounceVertical = false
            }
        }
    }

    /// Reset the icon badge, and drop already-delivered turn notifications so Notification
    /// Center matches. setBadgeCount is the iOS 16+ API; the deployment target is iOS 15,
    /// so fall back to applicationIconBadgeNumber below that.
    private func clearIconBadge(_ application: UIApplication) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0)
        } else {
            application.applicationIconBadgeNumber = 0
        }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    private func checkDeferredInvite() {
        let key = "rewordDeferredInviteChecked"
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: key) { return }   // only ever read the clipboard once, at first launch
        defaults.set(true, forKey: key)

        // hasURLs is a metadata check (no paste banner); only read contents if a URL is present.
        let pasteboard = UIPasteboard.general
        guard pasteboard.hasURLs, let str = pasteboard.string,
              let components = URLComponents(string: str),
              (components.host?.contains("rewordgame.app") ?? false),
              let gameId = components.queryItems?.first(where: { $0.name == "game" })?.value,
              !gameId.isEmpty else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if let bridge = (self.window?.rootViewController as? CAPBridgeViewController)?.bridge {
                bridge.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('deferredInvite', { detail: { gameId: '\(gameId)' } }))")
            }
        }
    }
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Handle Universal Links (https://www.rewordgame.app?game=XXXXXX)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL,
           let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
           let gameId = components.queryItems?.first(where: { $0.name == "game" })?.value {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                if let bridge = (self.window?.rootViewController as? CAPBridgeViewController)?.bridge {
                    bridge.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('universalLink', { detail: { gameId: '\(gameId)' } }))")
                }
            }
        }
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // APNs token registration — forward to Capacitor Push Notifications plugin
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}
