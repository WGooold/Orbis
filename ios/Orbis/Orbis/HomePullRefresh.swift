import Foundation
import CoreGraphics

/// iOS M15: observe a native top pull without introducing a refresh inset or a second return animation.
struct HomePullRefreshGesture {
    static let threshold: CGFloat = 80
    private var eligible = false
    private var vertical: Bool?

    mutating func begin(atTop: Bool, enabled: Bool) {
        eligible = atTop && enabled
        vertical = nil
    }

    mutating func update(translation: CGPoint) {
        guard vertical == nil, max(abs(translation.x), abs(translation.y)) >= 8 else { return }
        vertical = translation.y > abs(translation.x)
    }

    mutating func end(distance: CGFloat) -> Bool {
        defer { cancel() }
        return eligible && vertical == true && distance >= Self.threshold
    }

    mutating func cancel() { eligible = false; vertical = nil }
}

#if canImport(UIKit)
import SwiftUI
import UIKit

/// The scroll view owns dragging, deceleration and the entire rebound. This observer
/// never changes its offset/inset or replaces its delegate/gesture recognizers.
struct HomePullRefresh: UIViewRepresentable {
    let identity: String?
    let enabled: Bool
    let tint: UIColor
    let refresh: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Anchor {
        let view = Anchor()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.attach = { [weak coordinator = context.coordinator, weak view] in
            if let view { coordinator?.attach(from: view) }
        }
        return view
    }
    func updateUIView(_ view: Anchor, context: Context) {
        context.coordinator.identity = identity
        context.coordinator.enabled = enabled
        context.coordinator.refresh = refresh
        context.coordinator.indicator.color = tint
        view.attach?()
    }
    static func dismantleUIView(_ view: Anchor, coordinator: Coordinator) { coordinator.detach() }

    final class Anchor: UIView {
        var attach: (() -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); attach?() }
    }

    final class Coordinator: NSObject {
        var identity: String? {
            didSet { if identity != oldValue { gesture.cancel() } }
        }
        var enabled = true {
            didSet { if !enabled { gesture.cancel() } }
        }
        var refresh: (() -> Void)?
        let indicator = UIActivityIndicatorView(style: .medium)
        private weak var scrollView: UIScrollView?
        private var observation: NSKeyValueObservation?
        private var gesture = HomePullRefreshGesture()
        private var returning = false
        private var originalBounce = false

        func attach(from anchor: UIView) {
            var ancestor = anchor.superview
            while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
            guard let scroll = ancestor as? UIScrollView, scroll !== scrollView else { return }
            detach()
            scrollView = scroll
            originalBounce = scroll.alwaysBounceVertical
            scroll.alwaysBounceVertical = true
            indicator.isUserInteractionEnabled = false
            indicator.accessibilityElementsHidden = true
            scroll.addSubview(indicator)
            scroll.panGestureRecognizer.addTarget(self, action: #selector(panChanged(_:)))
            observation = scroll.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                self?.updateIndicator()
            }
            updateIndicator()
        }

        func detach() {
            observation = nil
            if let scrollView {
                scrollView.panGestureRecognizer.removeTarget(self, action: #selector(panChanged(_:)))
                scrollView.alwaysBounceVertical = originalBounce
            }
            indicator.stopAnimating()
            indicator.removeFromSuperview()
            scrollView = nil
            gesture.cancel()
            returning = false
        }

        private var pullDistance: CGFloat {
            guard let scrollView else { return 0 }
            return max(0, -scrollView.contentOffset.y - scrollView.adjustedContentInset.top)
        }

        private func updateIndicator() {
            guard let scrollView else { return }
            let distance = pullDistance
            if distance <= 0.5 { returning = false }
            indicator.center = CGPoint(x: scrollView.bounds.width / 2,
                                       y: -scrollView.adjustedContentInset.top - 32)
            indicator.alpha = enabled ? min(1, distance / 56) : 0
            if distance > 0.5 && enabled { indicator.startAnimating() }
            else { indicator.stopAnimating() }
        }

        @objc private func panChanged(_ pan: UIPanGestureRecognizer) {
            guard let scrollView else { return }
            let translation = pan.translation(in: scrollView.window)
            switch pan.state {
            case .began:
                gesture.begin(atTop: scrollView.contentOffset.y <= -scrollView.adjustedContentInset.top + 0.5,
                              enabled: enabled && !returning)
                gesture.update(translation: translation)
            case .changed:
                gesture.update(translation: translation)
            case .ended:
                if gesture.end(distance: pullDistance) {
                    returning = true
                    refresh?()
                }
            case .cancelled, .failed:
                gesture.cancel()
            default: break
            }
        }
    }
}
#endif
