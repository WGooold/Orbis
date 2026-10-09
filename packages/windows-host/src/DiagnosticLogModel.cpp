#include "DiagnosticLogModel.h"

DiagnosticLogModel::DiagnosticLogModel(QObject *parent) : QAbstractListModel(parent) {
    m_flushTimer.setSingleShot(true);
    m_flushTimer.setInterval(250);
    connect(&m_flushTimer, &QTimer::timeout, this, &DiagnosticLogModel::flush);
}

int DiagnosticLogModel::rowCount(const QModelIndex &parent) const {
    return parent.isValid() ? 0 : m_lines.size();
}
QVariant DiagnosticLogModel::data(const QModelIndex &index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_lines.size() || role != Qt::UserRole) return {};
    return m_lines.at(index.row());
}
QHash<int, QByteArray> DiagnosticLogModel::roleNames() const { return {{Qt::UserRole, "logText"}}; }

void DiagnosticLogModel::append(QString line) {
    if (line.isEmpty()) return;
    // Bound both the capture queue and rendered model, including a burst before Qt yields.
    m_pending.append(line.left(1600));
    if (m_pending.size() > MaxEntries) m_pending.removeFirst();
    if (!m_flushTimer.isActive()) m_flushTimer.start();
}
QStringList DiagnosticLogModel::snapshot() const {
    auto result = m_lines + m_pending;
    return result.last(qMin(result.size(), qsizetype(MaxEntries)));
}
void DiagnosticLogModel::flush() {
    if (m_pending.isEmpty()) return;
    const int removed = qMax(0, int(m_lines.size() + m_pending.size()) - MaxEntries);
    if (removed > 0) {
        beginRemoveRows({}, 0, removed - 1);
        m_lines.remove(0, removed);
        endRemoveRows();
    }
    const int first = m_lines.size();
    beginInsertRows({}, first, first + int(m_pending.size()) - 1);
    m_lines.append(m_pending);
    m_pending.clear();
    endInsertRows();
}
