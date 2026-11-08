#include "NeuSurface.h"
#include <QPainter>
#include <QPainterPath>
#include <algorithm>
#include <cmath>
#include <vector>

namespace {
QPainterPath roundedRect(const QRectF &rect, qreal radius) {
    QPainterPath path;
    path.addRoundedRect(rect, radius, radius);
    return path;
}

QImage gaussianShadow(const QSize &size, const QPainterPath &shape, qreal offset,
                      qreal sigma, const QColor &color, qreal opacity, bool inset) {
    const int reach = static_cast<int>(std::ceil(3 * sigma));
    const int padding = reach + static_cast<int>(std::ceil(std::abs(offset))) + 1;
    const int width = size.width() + 2 * padding;
    const int height = size.height() + 2 * padding;
    QImage mask(width, height, QImage::Format_ARGB32_Premultiplied);
    mask.fill(Qt::transparent);
    {
        QPainter painter(&mask);
        painter.setRenderHint(QPainter::Antialiasing);
        painter.fillPath(shape.translated(padding + offset, padding + offset), Qt::white);
    }

    std::vector<float> kernel(2 * reach + 1);
    float sum = 0;
    for (int i = -reach; i <= reach; ++i) {
        const float value = std::exp(-float(i * i) / float(2 * sigma * sigma));
        kernel[i + reach] = value;
        sum += value;
    }
    for (float &value : kernel) value /= sum;

    // Two one-dimensional convolutions blur the silhouette without contour bands.
    std::vector<float> horizontal(size_t(width) * height);
    for (int y = 0; y < height; ++y) {
        const auto *row = reinterpret_cast<const QRgb *>(mask.constScanLine(y));
        for (int x = 0; x < width; ++x) {
            // The rounded silhouette is convex: fully covered kernel endpoints
            // imply a fully covered interval. Avoid convolving the large flat interior.
            if (x >= reach && x + reach < width && qAlpha(row[x - reach]) == 255 && qAlpha(row[x + reach]) == 255) {
                horizontal[size_t(y) * width + x] = 255;
                continue;
            }
            float alpha = 0;
            for (int k = -reach; k <= reach; ++k) {
                const int sample = x + k;
                if (sample >= 0 && sample < width) alpha += kernel[k + reach] * qAlpha(row[sample]);
            }
            horizontal[size_t(y) * width + x] = alpha;
        }
    }

    QImage base;
    if (inset) {
        base = QImage(size, QImage::Format_ARGB32_Premultiplied);
        base.fill(Qt::transparent);
        QPainter painter(&base);
        painter.setRenderHint(QPainter::Antialiasing);
        painter.fillPath(shape, Qt::white);
    }

    QImage result(size, QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < size.height(); ++y) {
        auto *pixels = reinterpret_cast<QRgb *>(result.scanLine(y));
        const auto *basePixels = inset ? reinterpret_cast<const QRgb *>(base.constScanLine(y)) : nullptr;
        for (int x = 0; x < size.width(); ++x) {
            if (inset && qAlpha(basePixels[x]) == 0) { pixels[x] = 0; continue; }
            float blurred = 0;
            if (horizontal[size_t(y + padding - reach) * width + x + padding] >= 254.999f &&
                horizontal[size_t(y + padding + reach) * width + x + padding] >= 254.999f) blurred = 255;
            else for (int k = -reach; k <= reach; ++k)
                    blurred += kernel[k + reach] * horizontal[size_t(y + padding + k) * width + x + padding];
            const float coverage = inset ? qAlpha(basePixels[x]) * (1 - blurred / 255.f) : blurred;
            const int alpha = std::clamp(int(std::lround(coverage * opacity)), 0, 255);
            pixels[x] = qRgba(color.red() * alpha / 255, color.green() * alpha / 255,
                              color.blue() * alpha / 255, alpha);
        }
    }
    return result;
}
}

void NeuSurface::paint(QPainter *painter) {
    painter->setRenderHint(QPainter::Antialiasing);
    const QSize imageSize(static_cast<int>(std::ceil(width())), static_cast<int>(std::ceil(height())));
    const QRectF rect = boundingRect().adjusted(m_margin, m_margin, -m_margin, -m_margin);
    if (rect.isEmpty() || imageSize.isEmpty()) return;
    const auto base = roundedRect(rect, m_radius);
    const qreal relief = std::isfinite(m_relief) ? std::clamp(m_relief, qreal(-1), qreal(1)) : (m_inset ? -1 : 1);
    if (m_shadowSize != size() || m_shadowRadius != m_radius ||
        m_shadowMargin != m_margin ||
        m_shadowDepth != m_depth || m_shadowBlur != m_blur ||
        m_cachedScale != m_shadowScale || m_cachedHighlight != m_highlightColor ||
        m_cachedShade != m_shadeColor || m_cachedHighlightOpacity != m_highlightOpacity ||
        m_cachedShadeOpacity != m_shadeOpacity) {
        m_shadowSize = size();
        m_shadowRadius = m_radius;
        m_shadowMargin = m_margin;
        m_shadowInset = m_inset;
        m_shadowDepth = m_depth;
        m_shadowBlur = m_blur;
        m_cachedScale = m_shadowScale;
        m_cachedHighlight = m_highlightColor;
        m_cachedShade = m_shadeColor;
        m_cachedHighlightOpacity = m_highlightOpacity;
        m_cachedShadeOpacity = m_shadeOpacity;
        // Native depth tokens share offset/blur geometry; blur never exceeds offset.
        m_lightShadow = {}; m_darkShadow = {}; m_innerLightShadow = {}; m_innerDarkShadow = {};
    }
    const qreal offset = std::max(qreal(0.1), 4 * m_shadowScale * m_blur);
    const qreal sigma = offset;
    if (!m_flat && m_outerShadowEnabled && relief > 0 && m_lightShadow.isNull()) {
        m_lightShadow = gaussianShadow(imageSize, base, -offset, sigma, m_highlightColor,
                                       m_highlightOpacity, false);
        m_darkShadow = gaussianShadow(imageSize, base, offset, sigma, m_shadeColor,
                                      m_shadeOpacity * m_depth, false);
    }
    if (!m_flat && relief < 0 && m_innerLightShadow.isNull()) {
        m_innerLightShadow = gaussianShadow(imageSize, base, -offset, sigma, m_highlightColor,
                                            m_highlightOpacity, true);
        m_innerDarkShadow = gaussianShadow(imageSize, base, offset, sigma, m_shadeColor,
                                           m_shadeOpacity * m_depth, true);
    }
    if (!m_flat && m_outerShadowEnabled && relief > 0) {
        painter->setOpacity(relief);
        painter->drawImage(QPointF(0, 0), m_lightShadow);
        painter->drawImage(QPointF(0, 0), m_darkShadow);
        painter->setOpacity(1);
    }
    painter->fillPath(base, m_surface);
    if (!m_flat && relief < 0) {
        painter->setOpacity(-relief);
        painter->drawImage(QPointF(0, 0), m_innerLightShadow);
        painter->drawImage(QPointF(0, 0), m_innerDarkShadow);
        painter->setOpacity(1);
    }
    if (m_outlined) {
        painter->setPen(QPen(m_outlineColor, 1));
        painter->setBrush(Qt::NoBrush);
        painter->drawPath(roundedRect(rect.adjusted(0.5, 0.5, -0.5, -0.5), std::max(qreal(0), m_radius - 0.5)));
    }
    if (m_focused) {
        painter->setPen(QPen(m_focusColor, 2));
        painter->setBrush(Qt::NoBrush);
        painter->drawPath(roundedRect(rect.adjusted(-3, -3, 3, 3), m_radius + 3));
    }
}
