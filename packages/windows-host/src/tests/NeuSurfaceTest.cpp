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
            const double light = 0.78 * 0.5 * std::erfc((x + 0.5 - 140.5) / (std::sqrt(2.0) * 4));
            const double dark = 0.34 * 0.5 * std::erfc((x + 0.5 - 147.5) / (std::sqrt(2.0) * 4));
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
