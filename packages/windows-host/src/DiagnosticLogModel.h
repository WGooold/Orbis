#pragma once
#include <QAbstractListModel>
#include <QStringList>
#include <QTimer>

/** Bounded log capture; batch row updates without invalidating Host state bindings. */
class DiagnosticLogModel : public QAbstractListModel {
    Q_OBJECT
public:
    static constexpr int MaxEntries = 300;
    explicit DiagnosticLogModel(QObject *parent = nullptr);
    int rowCount(const QModelIndex &parent = {}) const override;
    QVariant data(const QModelIndex &index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;
    void append(QString line);
    /** Includes buffered lines so an immediate diagnostic export never omits a new error. */
    QStringList snapshot() const;
private:
    void flush();
    QStringList m_lines, m_pending;
    QTimer m_flushTimer;
};
