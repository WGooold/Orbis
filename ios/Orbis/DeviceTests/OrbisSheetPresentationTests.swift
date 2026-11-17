import SwiftUI
import UIKit
import XCTest
@testable import Orbis

/// Native `UISheetPresentationController` backing `.orbisBottomSheet`:
/// verifies detents, corner radius, `OrbisDismiss`, `retireIndependently`
/// replacement, stacked child sheets, and per-sheet `OrbisOverlay` dialogs.
@MainActor final class OrbisSheetPresentationTests: XCTestCase {
    private func until(_ label: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<250 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out: \(label)")
        throw URLError(.timedOut)
    }

    private func mount<V: View>(_ rootView: V, overlay: OrbisOverlay) -> (UIWindow, UIViewController) {
        let host = UIHostingController(rootView: AnyView(
            rootView
                .orbisOverlayHost(overlay)
                .modifier(OrbisDisplayPreferences())
        ))
        let window: UIWindow
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        } else {
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        }
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        return (window, host)
    }

    private func teardown(_ window: UIWindow) {
        window.rootViewController?.dismiss(animated: false)
        window.isHidden = true
        window.rootViewController = nil
    }

    func testMediumAndLargeDetentsConfigureNativeSheetPresentationController() async throws {
        @MainActor final class Model: ObservableObject {
            @Published var open = true
            @Published var detents: Set<PresentationDetent> = [.medium, .large]
        }
        struct Host: View {
            @ObservedObject var model: Model
            var body: some View {
                Color.clear
                    .orbisBottomSheet(isPresented: $model.open) {
                        VStack { Text("Picker") }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .orbisSheet(model.detents)
                    }
            }
        }

        let overlay = OrbisOverlay()
        let model = Model()
        let (window, root) = mount(Host(model: model), overlay: overlay)
        defer { teardown(window) }

        try await until("native sheet presented") { root.presentedViewController != nil }
        let presented = try XCTUnwrap(root.presentedViewController)
        let sheet = try XCTUnwrap(presented.sheetPresentationController)
        XCTAssertEqual(sheet.detents.count, 2)
        XCTAssertEqual(sheet.selectedDetentIdentifier, .medium)
        XCTAssertEqual(sheet.preferredCornerRadius, OrbisRadius.sheet)
        XCTAssertFalse(sheet.prefersGrabberVisible)
        XCTAssertNil(sheet.largestUndimmedDetentIdentifier)
        XCTAssertTrue(overlay.isPresenting)

        model.detents = [.large]
        try await until("detents updated to large") {
            sheet.detents.count == 1 && sheet.selectedDetentIdentifier == .large
        }

        model.open = false
        try await until("native sheet dismissed") {
            root.presentedViewController == nil && !overlay.isPresenting
        }
    }

    func testRetireIndependentlyReplacementKeepsSheetPresentedAndTearsDownOldContent() async throws {
        @MainActor final class Tracker: ObservableObject {
            @Published var token = "A"
            var disappeared: [String] = []
            var dismissed: [String] = []
            var appeared: [String] = []
            var activeDismiss: (() -> Void)?
        }
        struct InnerContent: View {
            let token: String
            let tracker: Tracker
            @OrbisDismiss private var dismiss
            var body: some View {
                VStack {
                    Text("Token \(token)")
                }
                .onAppear {
                    tracker.appeared.append(token)
                    tracker.activeDismiss = dismiss
                }
                .onDisappear {
                    tracker.disappeared.append(token)
                }
            }
        }
        struct ChildSheet: View {
            let token: String
            let tracker: Tracker
            @State private var open = true
            var body: some View {
                Color.clear.frame(width: 0, height: 0)
                    .orbisBottomSheet(isPresented: $open, onDismiss: {
                        tracker.dismissed.append(token)
                    }, retireIndependently: true) {
                        InnerContent(token: token, tracker: tracker)
                            .orbisSheet([.large])
                    }
            }
        }
        struct Host: View {
            @ObservedObject var tracker: Tracker
            var body: some View {
                ZStack {
                    ChildSheet(token: tracker.token, tracker: tracker).id(tracker.token)
                }
            }
        }

        let overlay = OrbisOverlay()
        let tracker = Tracker()
        let (window, root) = mount(Host(tracker: tracker), overlay: overlay)
        defer { teardown(window) }

        try await until("token A appeared") {
            root.presentedViewController != nil && tracker.appeared == ["A"]
        }
        let initialVC = root.presentedViewController

        // Simulate IOS-CHAT-05 replaceTool: remove A and mount B in the same state update.
        tracker.token = "B"
        try await until("token B appeared and A retired") {
            tracker.appeared == ["A", "B"] &&
            tracker.disappeared.contains("A") &&
            tracker.dismissed.contains("A")
        }
        XCTAssertTrue(root.presentedViewController === initialVC,
                      "In-place replacement should keep the native sheet container open")
        XCTAssertEqual(overlay.sheets.count, 1)

        tracker.activeDismiss?()
        try await until("token B dismissed") {
            root.presentedViewController == nil && tracker.dismissed == ["A", "B"]
        }
    }

    func testPerSheetOverlayDialogAndNestedSheetStackAndCascadeDismiss() async throws {
        @MainActor final class StateModel: ObservableObject {
            @Published var openFirst = true
            @Published var openSecond = false
            var firstDismissed = false
            var secondDismissed = false
            var infoTrigger: (() -> Void)?
            var childOverlay: OrbisOverlay?
        }
        struct SecondSheet: View {
            var body: some View {
                Text("Nested").orbisSheet([.large])
            }
        }
        struct FirstSheet: View {
            @ObservedObject var state: StateModel
            @EnvironmentObject private var overlay: OrbisOverlay
            var body: some View {
                VStack {
                    OrbisInfoButton(title: "Info", message: "Details")
                }
                .onAppear {
                    state.childOverlay = overlay
                    state.infoTrigger = {
                        overlay.showDialog("Info", message: "Details", actions: [])
                    }
                }
                .orbisBottomSheet(isPresented: $state.openSecond, onDismiss: {
                    state.secondDismissed = true
                }) {
                    SecondSheet()
                }
                .orbisSheet([.medium, .large])
            }
        }
        struct Host: View {
            @ObservedObject var state: StateModel
            var body: some View {
                Color.clear.orbisBottomSheet(isPresented: $state.openFirst, onDismiss: {
                    state.firstDismissed = true
                }) {
                    FirstSheet(state: state)
                }
            }
        }

        let rootOverlay = OrbisOverlay()
        let state = StateModel()
        let (window, root) = mount(Host(state: state), overlay: rootOverlay)
        defer { teardown(window) }

        try await until("first sheet mounted") {
            root.presentedViewController != nil && state.childOverlay != nil
        }
        let vc1 = try XCTUnwrap(root.presentedViewController)
        XCTAssertFalse(vc1.isModalInPresentation)

        state.infoTrigger?()
        try await until("dialog locks interactive sheet dismissal") {
            state.childOverlay?.dialog != nil && vc1.isModalInPresentation
        }
        state.childOverlay?.dismissDialog()
        try await until("dialog dismissed unlocks sheet") {
            state.childOverlay?.dialog == nil && !vc1.isModalInPresentation
        }

        state.openSecond = true
        try await until("second sheet stacked on first") {
            vc1.presentedViewController != nil
        }
        XCTAssertTrue(state.childOverlay?.isPresenting == true)

        state.openFirst = false
        try await until("dismissing first cascades cleanup to second") {
            root.presentedViewController == nil && state.firstDismissed && state.secondDismissed
        }
    }
}
