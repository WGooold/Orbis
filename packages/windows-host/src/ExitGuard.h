#pragma once
#include <QObject>
#include <QEvent>
#include <functional>

/** Keep native Quit (including Cmd+Q) behind the same confirmation as the tray. */
class ExitGuard : public QObject {
public:
    ExitGuard(std::function<bool()> approved, std::function<void()> request, QObject *parent = nullptr)
        : QObject(parent), m_approved(std::move(approved)), m_request(std::move(request)) {}
protected:
    bool eventFilter(QObject *, QEvent *event) override {
        if (event->type() != QEvent::Quit || m_approved()) return false;
        m_request(); event->ignore(); return true;
    }
private:
    std::function<bool()> m_approved;
    std::function<void()> m_request;
};
