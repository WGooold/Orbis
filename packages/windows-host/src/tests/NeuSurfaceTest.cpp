#include "../NeuSurface.h"
#include <QPainter>
#include <QtTest>
#include <cmath>

class NeuSurfaceTest : public QObject {
    Q_OBJECT
    static QImage render(NeuSurface &surface) {
        QImage image(QSize(int(std::ceil(surface.width())), int(std::ceil(surface.height()))), QImage::Format_ARGB32_Premultiplied);
        image.fill(Qt::transparent);
        QPainter painter(&image);
        surface.paint(&painter);
        return image;
    }
private slots:
    void outerShadowFollowsGaussianFalloff() {
        NeuSurface surface;
        surface.setSize(QSizeF(160, 96));
        surface.setMargin(16);
        const auto image = render(surface);
        for (int x = 145; x <= 157; ++x) {
            // At a straight edge, a Gaussian-blurred half-plane has an erfc profile.
            const double light = 0.9 * 0.5 * std::erfc((x + 0.5 - 140) / (std::sqrt(2.0) * 4));
            const double dark = 0.55 * 0.5 * std::erfc((x + 0.5 - 148) / (std::sqrt(2.0) * 4));
            const int expected = int(std::lround(255 * (dark + light * (1 - dark))));
            const int actual = qAlpha(image.pixel(x, 48));
            QVERIFY2(std::abs(actual - expected) <= 2,
                     qPrintable(QString("x=%1 alpha=%2 expected=%3").arg(x).arg(actual).arg(expected)));
        }
    }
    void insetIsClippedAndLitFromTopLeft() {
        NeuSurface surface;
        surface.setSize(QSizeF(160, 96));
        surface.setMargin(16);
        surface.setInset(true);
        const auto image = render(surface);
        QCOMPARE(qAlpha(image.pixel(15, 48)), 0);
        QCOMPARE(qAlpha(image.pixel(144, 48)), 0);
        QCOMPARE(image.pixelColor(80, 48), surface.surface());
        QVERIFY(image.pixelColor(17, 48).lightness() < surface.surface().lightness());
        QVERIFY(image.pixelColor(142, 48).lightness() > surface.surface().lightness());
    }
    void geometryAndModeChangesRefreshShadowCache() {
        NeuSurface surface;
        surface.setSize(QSizeF(160, 96));
        surface.setMargin(16);
        const auto raised = render(surface);
        QCOMPARE(render(surface), raised);
        surface.setFocused(true);
        QVERIFY(render(surface) != raised);
        surface.setFocused(false);
        QCOMPARE(render(surface), raised);
        surface.setDepth(3);
        QVERIFY(render(surface) != raised);
        surface.setDepth(1);
        QCOMPARE(render(surface), raised);
        surface.setBlur(0.5);
        QVERIFY(render(surface) != raised);
        surface.setBlur(1);
        QCOMPARE(render(surface), raised);
        surface.setCornerRadius(20);
        QVERIFY(render(surface) != raised);
        surface.setInset(true);
        QCOMPARE(qAlpha(render(surface).pixel(148, 48)), 0);
        surface.setInset(false);
        surface.setSize(QSizeF(200, 96));
        surface.setMargin(20);
        const auto resized = render(surface);
        QCOMPARE(resized.pixelColor(148, 48), surface.surface());
        QVERIFY(qAlpha(resized.pixel(184, 48)) > 0);
    }
    // Theme and relief changes must not reuse shadows baked for a different palette.
    void themedCacheAndContinuousReliefKeepTheSameMaterial() {
        NeuSurface surface;
        surface.setSize(QSizeF(160, 96));
        surface.setMargin(16);
        surface.setRelief(1);
        const auto raised = render(surface);
        surface.setRelief(0);
        const auto neutral = render(surface);
        QCOMPARE(neutral.pixelColor(80, 48), surface.surface());
        QCOMPARE(qAlpha(neutral.pixel(148, 48)), 0);
        surface.setRelief(-1);
        const auto inset = render(surface);
        QCOMPARE(inset.pixelColor(80, 48), surface.surface());
        QVERIFY(inset != neutral && inset != raised);
        surface.setFlat(true);
        QCOMPARE(render(surface), neutral);
        surface.setFlat(false);
        surface.setOuterShadowEnabled(false); surface.setRelief(1);
        QCOMPARE(render(surface), neutral);
        surface.setRelief(-1);
        QCOMPARE(render(surface), inset);
        surface.setOuterShadowEnabled(true);
        surface.setHighlightColor(QColor("#343946"));
        surface.setShadeColor(QColor("#0a0c11"));
        surface.setSurface(QColor("#23262e"));
        const auto dark = render(surface);
        QVERIFY(dark != inset);
        QCOMPARE(dark.pixelColor(80, 48), QColor("#23262e"));
        NeuSurface fresh;
        fresh.setSize(surface.size()); fresh.setMargin(16); fresh.setRelief(-1);
        fresh.setHighlightColor(QColor("#343946")); fresh.setShadeColor(QColor("#0a0c11")); fresh.setSurface(QColor("#23262e"));
        QCOMPARE(dark, render(fresh));
    }
    // Disabled controls keep their material at full opacity and expose only a hairline.
    void disabledOutlineAndKeyboardFocusStayOutsideContent() {
        NeuSurface surface;
        surface.setSize(QSizeF(160, 96)); surface.setMargin(16);
        surface.setFlat(true); surface.setOutlined(true);
        const auto disabled = render(surface);
        QCOMPARE(disabled.pixelColor(80, 48), surface.surface());
        QCOMPARE(qAlpha(disabled.pixel(148, 48)), 0);
        surface.setFocused(true);
        const auto focused = render(surface);
        QVERIFY(focused != disabled);
        QVERIFY(qAlpha(focused.pixel(147, 48)) > 0);
        QCOMPARE(focused.pixelColor(80, 48), surface.surface());
    }
    void fractionalResizeMatchesFreshRender() {
        NeuSurface surface;
        surface.setSize(QSizeF(160.1, 96));
        render(surface);
        surface.setSize(QSizeF(160.9, 96));
        NeuSurface fresh;
        fresh.setSize(surface.size());
        QCOMPARE(render(surface), render(fresh));
    }
};
QTEST_MAIN(NeuSurfaceTest)
#include "NeuSurfaceTest.moc"
