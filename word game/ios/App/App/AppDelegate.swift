import UIKit
import Capacitor
import UserNotifications

// The app uses the UIScene lifecycle (required on iOS 27+). Window-level work lives in
// SceneDelegate below; this class keeps the process-level hooks (APNs token, launch).
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    // APNs token registration — forward to Capacitor Push Notifications plugin
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    // Set by UIKit from the storyboard named in the scene manifest (Info.plist).
    var window: UIWindow?

    private var bridge: CAPBridgeProtocol? {
        (window?.rootViewController as? CAPBridgeViewController)?.bridge
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Cold launch from a link: iOS hands the URL/activity here instead of to the app delegate.
        for context in connectionOptions.urlContexts {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
        for activity in connectionOptions.userActivities {
            handleUserActivity(activity)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // Clear the app icon badge. Every turn notification ships badge: 1 (see api/notify.js),
        // and nothing else resets it — there's no badge plugin, and the in-app games badge is a
        // DOM element, not the icon. Without this the red 1 sticks permanently once a push has
        // arrived, no matter how many times the app is opened.
        clearIconBadge(UIApplication.shared)
        // Deferred deep link: on the very first launch (e.g. installed from a
        // challenge link), recover the game code the web prompt stashed on the
        // clipboard, since iOS doesn't pass the original link to a fresh install.
        checkDeferredInvite()
        // Disable native scroll-view bouncing so the fixed header/footer can't be dragged
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if let bridge = self.bridge {
                bridge.webView?.scrollView.bounces = false
                bridge.webView?.scrollView.alwaysBounceVertical = false
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        handleUserActivity(userActivity)
    }

    /// Reset the icon badge, and drop already-delivered turn notifications so Notification
    /// Center matches. setBadgeCount is the iOS 16+ API; the deployment target is iOS 16.
    private func clearIconBadge(_ application: UIApplication) {
        UNUserNotificationCenter.current().setBadgeCount(0)
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
            self.bridge?.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('deferredInvite', { detail: { gameId: '\(gameId)' } }))")
        }
    }

    private func handleUserActivity(_ userActivity: NSUserActivity) {
        // Handle Universal Links (https://www.rewordgame.app?game=XXXXXX)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL,
           let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
           let gameId = components.queryItems?.first(where: { $0.name == "game" })?.value {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self.bridge?.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('universalLink', { detail: { gameId: '\(gameId)' } }))")
            }
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
