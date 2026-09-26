#pragma once
#include <QImage>
#include <QQuickPaintedItem>
#include <QtQml/qqmlregistration.h>

/** Software-renderable Gaussian outer and clipped inner shadows. */
class NeuSurface : public QQuickPaintedItem {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool inset READ inset WRITE setInset NOTIFY appearanceChanged)
    Q_PROPERTY(qreal cornerRadius READ cornerRadius WRITE setCornerRadius NOTIFY appearanceChanged)
    Q_PROPERTY(qreal margin READ margin WRITE setMargin NOTIFY appearanceChanged)
    Q_PROPERTY(QColor surface READ surface WRITE setSurface NOTIFY appearanceChanged)
    Q_PROPERTY(bool focused READ focused WRITE setFocused NOTIFY appearanceChanged)
    /** Depth of the shading shadow; the opposite highlight keeps its base strength. */
    Q_PROPERTY(qreal depth READ depth WRITE setDepth NOTIFY appearanceChanged)
    /** Shadow tightness: 1 spreads the blur and offset of this item's size class, below 1 tightens it. */
    Q_PROPERTY(qreal blur READ blur WRITE setBlur NOTIFY appearanceChanged)
public:
    explicit NeuSurface(QQuickItem *parent = nullptr) : QQuickPaintedItem(parent) { setAntialiasing(true); }
    bool inset() const { return m_inset; }
    qreal cornerRadius() const { return m_radius; }
    qreal margin() const { return m_margin; }
    QColor surface() const { return m_surface; }
    bool focused() const { return m_focused; }
    qreal depth() const { return m_depth; }
    qreal blur() const { return m_blur; }
    void setInset(bool value) { if (m_inset != value) { m_inset = value; refresh(); } }
    void setCornerRadius(qreal value) { if (m_radius != value) { m_radius = value; refresh(); } }
    void setMargin(qreal value) { if (m_margin != value) { m_margin = value; refresh(); } }
    void setSurface(QColor value) { if (m_surface != value) { m_surface = value; refresh(); } }
    void setFocused(bool value) { if (m_focused != value) { m_focused = value; refresh(); } }
    void setDepth(qreal value) { if (m_depth != value) { m_depth = value; refresh(); } }
    void setBlur(qreal value) { if (m_blur != value) { m_blur = value; refresh(); } }
    void paint(QPainter *painter) override;
signals:
    void appearanceChanged();
private:
    void refresh() { update(); emit appearanceChanged(); }
    bool m_inset = false, m_focused = false;
    qreal m_radius = 6, m_margin = 12, m_depth = 1, m_blur = 1;
    QColor m_surface{"#E6EBF4"};
    QSizeF m_shadowSize;
    qreal m_shadowRadius = -1, m_shadowMargin = -1, m_shadowDepth = -1, m_shadowBlur = -1;
    bool m_shadowInset = false;
    QImage m_lightShadow, m_darkShadow;
};
