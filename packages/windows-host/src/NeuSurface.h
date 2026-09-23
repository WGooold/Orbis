#pragma once
#include <QQuickPaintedItem>
#include <QtQml/qqmlregistration.h>

/** Software-renderable soft surfaces: true clipped inner shadows, no platform shader dependency. */
class NeuSurface : public QQuickPaintedItem {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool inset READ inset WRITE setInset NOTIFY appearanceChanged)
    Q_PROPERTY(qreal cornerRadius READ cornerRadius WRITE setCornerRadius NOTIFY appearanceChanged)
    Q_PROPERTY(qreal margin READ margin WRITE setMargin NOTIFY appearanceChanged)
    Q_PROPERTY(QColor surface READ surface WRITE setSurface NOTIFY appearanceChanged)
    Q_PROPERTY(bool focused READ focused WRITE setFocused NOTIFY appearanceChanged)
public:
    explicit NeuSurface(QQuickItem *parent = nullptr) : QQuickPaintedItem(parent) { setAntialiasing(true); }
    bool inset() const { return m_inset; }
    qreal cornerRadius() const { return m_radius; }
    qreal margin() const { return m_margin; }
    QColor surface() const { return m_surface; }
    bool focused() const { return m_focused; }
    void setInset(bool value) { if (m_inset != value) { m_inset = value; refresh(); } }
    void setCornerRadius(qreal value) { if (m_radius != value) { m_radius = value; refresh(); } }
    void setMargin(qreal value) { if (m_margin != value) { m_margin = value; refresh(); } }
    void setSurface(QColor value) { if (m_surface != value) { m_surface = value; refresh(); } }
    void setFocused(bool value) { if (m_focused != value) { m_focused = value; refresh(); } }
    void paint(QPainter *painter) override;
signals:
    void appearanceChanged();
private:
    void refresh() { update(); emit appearanceChanged(); }
    bool m_inset = false, m_focused = false;
    qreal m_radius = 12, m_margin = 12;
    QColor m_surface{"#E6EBF4"};
};
