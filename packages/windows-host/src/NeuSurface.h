#pragma once
#include <QImage>
#include <QQuickPaintedItem>
#include <QtQml/qqmlregistration.h>

/** Software-renderable Gaussian outer and clipped inner shadows. */
class NeuSurface : public QQuickPaintedItem {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool inset READ inset WRITE setInset NOTIFY insetChanged)
    Q_PROPERTY(qreal cornerRadius READ cornerRadius WRITE setCornerRadius NOTIFY appearanceChanged)
    Q_PROPERTY(qreal margin READ margin WRITE setMargin NOTIFY appearanceChanged)
    Q_PROPERTY(QColor surface READ surface WRITE setSurface NOTIFY surfaceChanged)
    Q_PROPERTY(bool focused READ focused WRITE setFocused NOTIFY appearanceChanged)
    /** Depth of the shading shadow; the opposite highlight keeps its base strength. */
    Q_PROPERTY(qreal depth READ depth WRITE setDepth NOTIFY appearanceChanged)
    /** Shadow tightness: 1 spreads the blur and offset of this item's size class, below 1 tightens it. */
    Q_PROPERTY(qreal blur READ blur WRITE setBlur NOTIFY appearanceChanged)
    Q_PROPERTY(qreal shadowScale READ shadowScale WRITE setShadowScale NOTIFY appearanceChanged)
    Q_PROPERTY(qreal relief READ relief WRITE setRelief NOTIFY reliefChanged)
    Q_PROPERTY(bool flat READ flat WRITE setFlat NOTIFY appearanceChanged)
    Q_PROPERTY(bool outerShadowEnabled READ outerShadowEnabled WRITE setOuterShadowEnabled NOTIFY appearanceChanged)
    Q_PROPERTY(bool outlined READ outlined WRITE setOutlined NOTIFY appearanceChanged)
    Q_PROPERTY(QColor highlightColor READ highlightColor WRITE setHighlightColor NOTIFY appearanceChanged)
    Q_PROPERTY(QColor shadeColor READ shadeColor WRITE setShadeColor NOTIFY appearanceChanged)
    Q_PROPERTY(QColor focusColor READ focusColor WRITE setFocusColor NOTIFY appearanceChanged)
    Q_PROPERTY(QColor outlineColor READ outlineColor WRITE setOutlineColor NOTIFY appearanceChanged)
    Q_PROPERTY(qreal highlightOpacity READ highlightOpacity WRITE setHighlightOpacity NOTIFY appearanceChanged)
    Q_PROPERTY(qreal shadeOpacity READ shadeOpacity WRITE setShadeOpacity NOTIFY appearanceChanged)
public:
    explicit NeuSurface(QQuickItem *parent = nullptr) : QQuickPaintedItem(parent) { setAntialiasing(true); }
    bool inset() const { return m_inset; }
    qreal cornerRadius() const { return m_radius; }
    qreal margin() const { return m_margin; }
    QColor surface() const { return m_surface; }
    bool focused() const { return m_focused; }
    qreal depth() const { return m_depth; }
    qreal blur() const { return m_blur; }
    qreal shadowScale() const { return m_shadowScale; }
    qreal relief() const { return m_relief; }
    bool flat() const { return m_flat; }
    bool outerShadowEnabled() const { return m_outerShadowEnabled; }
    bool outlined() const { return m_outlined; }
    QColor highlightColor() const { return m_highlightColor; }
    QColor shadeColor() const { return m_shadeColor; }
    QColor focusColor() const { return m_focusColor; }
    QColor outlineColor() const { return m_outlineColor; }
    qreal highlightOpacity() const { return m_highlightOpacity; }
    qreal shadeOpacity() const { return m_shadeOpacity; }
    void setInset(bool value) { if (m_inset != value) { m_inset = value; refresh(); emit insetChanged(); } }
    void setCornerRadius(qreal value) { if (m_radius != value) { m_radius = value; refresh(); } }
    void setMargin(qreal value) { if (m_margin != value) { m_margin = value; refresh(); } }
    void setSurface(QColor value) { if (m_surface != value) { m_surface = value; refresh(); emit surfaceChanged(); } }
    void setFocused(bool value) { if (m_focused != value) { m_focused = value; refresh(); } }
    void setDepth(qreal value) { if (m_depth != value) { m_depth = value; refresh(); } }
    void setBlur(qreal value) { if (m_blur != value) { m_blur = value; refresh(); } }
    void setShadowScale(qreal value) { if (m_shadowScale != value) { m_shadowScale = value; refresh(); } }
    void setRelief(qreal value) { if (m_relief != value) { m_relief = value; refresh(); emit reliefChanged(); } }
    void setFlat(bool value) { if (m_flat != value) { m_flat = value; refresh(); } }
    void setOuterShadowEnabled(bool value) { if (m_outerShadowEnabled != value) { m_outerShadowEnabled = value; refresh(); } }
    void setOutlined(bool value) { if (m_outlined != value) { m_outlined = value; refresh(); } }
    void setHighlightColor(QColor value) { if (m_highlightColor != value) { m_highlightColor = value; refresh(); } }
    void setShadeColor(QColor value) { if (m_shadeColor != value) { m_shadeColor = value; refresh(); } }
    void setFocusColor(QColor value) { if (m_focusColor != value) { m_focusColor = value; refresh(); } }
    void setOutlineColor(QColor value) { if (m_outlineColor != value) { m_outlineColor = value; refresh(); } }
    void setHighlightOpacity(qreal value) { if (m_highlightOpacity != value) { m_highlightOpacity = value; refresh(); } }
    void setShadeOpacity(qreal value) { if (m_shadeOpacity != value) { m_shadeOpacity = value; refresh(); } }
    void paint(QPainter *painter) override;
signals:
    void appearanceChanged();
    void insetChanged();
    void surfaceChanged();
    void reliefChanged();
private:
    void refresh() { update(); emit appearanceChanged(); }
    bool m_inset = false, m_focused = false;
    qreal m_radius = 6, m_margin = 12, m_depth = 1, m_blur = 1;
    // NaN keeps direct C++ users on the inset API; QML supplies continuous relief.
    qreal m_relief = qQNaN(), m_shadowScale = 1;
    bool m_flat = false, m_outlined = false, m_outerShadowEnabled = true;
    QColor m_surface{"#E6EBF4"};
    QColor m_highlightColor{"#ffffff"}, m_shadeColor{"#a6b2c6"};
    QColor m_focusColor{"#2f5287"}, m_outlineColor{"#c9d1de"};
    qreal m_highlightOpacity = 0.9, m_shadeOpacity = 0.55;
    QSizeF m_shadowSize;
    qreal m_shadowRadius = -1, m_shadowMargin = -1, m_shadowDepth = -1, m_shadowBlur = -1;
    bool m_shadowInset = false;
    qreal m_cachedScale = -1, m_cachedHighlightOpacity = -1, m_cachedShadeOpacity = -1;
    QColor m_cachedHighlight, m_cachedShade;
    QImage m_lightShadow, m_darkShadow;
    QImage m_innerLightShadow, m_innerDarkShadow;
};
