#include "StartupSettings.h"
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>

bool writeLoginAgent(const QString &path, const QString &program, bool enabled, QString *error) {
    if (!enabled) {
        if (!QFile::exists(path) || QFile::remove(path)) return true;
        if (error) *error = "无法关闭 macOS 登录启动";
        return false;
    }
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) {
        if (error) *error = "无法创建 macOS 登录启动目录";
        return false;
    }
    const auto xml = QStringLiteral("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>com.orbis.host</string><key>ProgramArguments</key><array><string>%1</string><string>--tray</string></array><key>RunAtLoad</key><true/></dict></plist>").arg(program.toHtmlEscaped());
    const auto bytes = xml.toUtf8();
    QSaveFile file(path);
    if (file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.commit()) return true;
    if (error) *error = "无法保存 macOS 登录启动设置：" + file.errorString();
    return false;
}
