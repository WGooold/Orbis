#include "NeuSurface.h"
#include <QPainter>
#include <QPainterPath>
#include <cmath>

void NeuSurface::paint(QPainter *painter) {
    painter->setRenderHint(QPainter::Antialiasing);
    const QRectF rect = boundingRect().adjusted(m_margin, m_margin, -m_margin, -m_margin);
    if (rect.isEmpty()) return;
    const auto shape = [](const QRectF &r, qreal radius) { QPainterPath path; path.addRoundedRect(r, radius, radius); return path; };
    const auto base = shape(rect, m_radius);
    constexpr int rings = 24;
    const auto shadow = [&](QColor color, qreal strength, qreal offset) {
        qreal totalWeight = 0;
        for (int i = 0; i < rings; ++i) totalWeight += std::pow(1.0 - qreal(i) / rings, 2);
        for (int i = rings - 1; i >= 0; --i) {
            const qreal spread = qreal(i) / rings * 9;
            const qreal weight = std::pow(1.0 - qreal(i) / rings, 2);
            color.setAlphaF(1 - std::pow(1 - strength, weight / totalWeight));
            const auto shifted = shape(rect.adjusted(-spread, -spread, spread, spread).translated(offset, offset), m_radius + spread);
            painter->fillPath(m_inset ? base.subtracted(shifted) : shifted, color);
        }
    };
    if (m_inset) {
        painter->fillPath(base, m_surface);
        painter->save(); painter->setClipPath(base);
        shadow(QColor("#A6B2C6"), 0.5, 4);
        shadow(Qt::white, 0.9, -4);
        painter->restore();
    } else {
        shadow(QColor("#A6B2C6"), 0.5, 5);
        shadow(Qt::white, 0.9, -5);
        painter->fillPath(base, m_surface);
    }
    if (m_focused) { painter->setPen(QPen(QColor("#2459D3"), 1.6)); painter->setBrush(Qt::NoBrush); painter->drawPath(base); }
}
