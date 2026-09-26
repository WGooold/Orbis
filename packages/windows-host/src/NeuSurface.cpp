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
            float blurred = 0;
            for (int k = -reach; k <= reach; ++k)
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
    if (m_shadowSize != size() || m_shadowRadius != m_radius ||
        m_shadowMargin != m_margin || m_shadowInset != m_inset ||
        m_shadowDepth != m_depth || m_shadowBlur != m_blur) {
        m_shadowSize = size();
        m_shadowRadius = m_radius;
        m_shadowMargin = m_margin;
        m_shadowInset = m_inset;
        m_shadowDepth = m_depth;
        m_shadowBlur = m_blur;
        const qreal offset = (m_inset ? 2.5 : 3.5) * m_blur;
        const qreal sigma = (m_inset ? 3.2 : 4.0) * m_blur;
        m_lightShadow = gaussianShadow(imageSize, base, -offset, sigma, Qt::white,
                                       m_inset ? 0.65 : 0.78, m_inset);
        m_darkShadow = gaussianShadow(imageSize, base, offset, sigma, QColor("#93A3BB"),
                                      (m_inset ? 0.23 : 0.34) * m_depth, m_inset);
    }
    if (m_inset) painter->fillPath(base, m_surface);
    painter->drawImage(QPointF(0, 0), m_lightShadow);
    painter->drawImage(QPointF(0, 0), m_darkShadow);
    if (!m_inset) painter->fillPath(base, m_surface);
    if (m_focused) {
        painter->setPen(QPen(QColor("#2459D3"), 1.5));
        painter->setBrush(Qt::NoBrush);
        painter->drawPath(base);
    }
}
