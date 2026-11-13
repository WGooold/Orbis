#include <QFile>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QtTest>
#include <memory>

// Match HostController's shared NOTIFY signal: even an unchanged email is
// notified by every status tick, policy refresh and request completion.
class RegistrationHost : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString email MEMBER email NOTIFY changed)
    Q_PROPERTY(QString relayUrl MEMBER relayUrl NOTIFY changed)
    Q_PROPERTY(QString hostId MEMBER hostId NOTIFY changed)
    Q_PROPERTY(bool busy MEMBER busy NOTIFY changed)
    Q_PROPERTY(int cooldown MEMBER cooldown NOTIFY changed)
    Q_PROPERTY(bool verificationRequired READ yes NOTIFY changed)
    Q_PROPERTY(bool bridgeReady READ yes NOTIFY changed)
    Q_PROPERTY(bool registrationAvailable READ yes NOTIFY changed)
public:
    QString email, relayUrl = "wss://relay-a.example", hostId = "host-a", requestedEmail;
    bool busy = false;
    int cooldown = 0;
    bool yes() const { return true; }
    Q_INVOKABLE void requestCode(const QString &value) { requestedEmail = value; cooldown = 60; emit changed(); }
signals:
    void changed();
};

class RegistrationInputTest : public QObject {
    Q_OBJECT
    QString m_form;
    std::unique_ptr<QObject> create(QQmlEngine &engine, RegistrationHost &host) {
        engine.rootContext()->setContextProperty("host", &host);
        QQmlComponent component(&engine);
        component.setData(m_form.toUtf8(), QUrl());
        if (!component.isReady()) { qWarning().noquote() << component.errorString(); return {}; }
        return std::unique_ptr<QObject>(component.create());
    }
    static void type(QQuickWindow *window, QQuickItem *field, const QString &value) {
        field->forceActiveFocus();
        for (const auto letter : value.toLatin1()) QTest::keyClick(window, letter);
    }
private slots:
    void initTestCase() {
        QQuickStyle::setStyle("Basic");
        QFile source(QStringLiteral(ORBIS_MAIN_QML)); QVERIFY(source.open(QIODevice::ReadOnly));
        const auto text = QString::fromUtf8(source.readAll());
        // Exercise production field bindings and the real request-code handler;
        // only decorative Field/ActionButton styling is replaced in this fixture.
        const auto fieldStart = text.lastIndexOf("Field {", text.indexOf("id: emailField"));
        const auto end = text.indexOf("Label { visible: host.verificationRequired; text: \"邮箱验证码\"", fieldStart);
        const auto codeStart = text.indexOf("Field { id: codeField;", end);
        const auto codeEnd = text.indexOf('\n', codeStart);
        const auto buttonStart = text.indexOf("ActionButton { text: host.cooldown", codeEnd);
        const auto buttonEnd = text.indexOf('\n', buttonStart);
        QVERIFY(fieldStart >= 0 && end > fieldStart && codeStart > end && codeEnd > codeStart && buttonStart > codeEnd);
        const auto button = QString(text.mid(buttonStart, buttonEnd - buttonStart)).replace("ActionButton {", "ActionButton { objectName: \"requestCode\";");
        m_form = "import QtQuick\nimport QtQuick.Controls\nimport QtQuick.Layouts\nApplicationWindow {\n"
            "width: 540; height: 260; visible: true\n"
            "component Field: TextField {}\ncomponent ActionButton: Button {}\n"
            "ColumnLayout { anchors.fill: parent\n" + text.mid(fieldStart, end - fieldStart)
            + text.mid(codeStart, codeEnd - codeStart) + '\n' + button + "\n}\n}";
    }
    void editsSurviveStatusAndCodeRequests_data() {
        QTest::addColumn<QString>("savedEmail");
        QTest::newRow("new-mailbox") << "";
        QTest::newRow("recovering-mailbox") << "owner@qq.com";
    }
    void editsSurviveStatusAndCodeRequests() {
        // HOST-ACT-13: typing, deleting, selection, focus changes and request
        // completion must preserve the draft, including a deliberately empty one.
        QFETCH(QString, savedEmail);
        RegistrationHost host; host.email = savedEmail;
        QQmlEngine engine; auto view = create(engine, host); QVERIFY(view);
        auto *window = qobject_cast<QQuickWindow *>(view.get()); QVERIFY(window);
        auto *email = view->findChild<QQuickItem *>("registrationEmail"); QVERIFY(email);
        auto *code = view->findChild<QQuickItem *>("verificationCode"); QVERIFY(code);
        QTRY_VERIFY(window->isVisible());
        QCOMPARE(email->property("text").toString(), savedEmail);
        email->forceActiveFocus();
        QVERIFY(QMetaObject::invokeMethod(email, "selectAll"));
        QTest::keyClick(window, Qt::Key_Backspace);
        emit host.changed();
        QCOMPARE(email->property("text").toString(), QString());
        type(window, email, "typed@qq.com");
        QCOMPARE(email->property("text").toString(), QString("typed@qq.com"));
        QVERIFY(QMetaObject::invokeMethod(email, "select", Q_ARG(int, 1), Q_ARG(int, 4)));
        for (int i = 0; i < 3; ++i) { emit host.changed(); QCoreApplication::processEvents(); }
        QCOMPARE(email->property("text").toString(), QString("typed@qq.com"));
        QCOMPARE(email->property("selectedText").toString(), QString("ype"));
        type(window, code, "123456");
        host.busy = true; emit host.changed();
        host.busy = false; emit host.changed();
        QCOMPARE(email->property("text").toString(), QString("typed@qq.com"));
        QCOMPARE(code->property("text").toString(), QString("123456"));
        auto *request = view->findChild<QObject *>("requestCode"); QVERIFY(request);
        QVERIFY(QMetaObject::invokeMethod(request, "clicked"));
        QCOMPARE(host.requestedEmail, QString("typed@qq.com"));
        --host.cooldown; emit host.changed();
        QCOMPARE(email->property("text").toString(), QString("typed@qq.com"));
        QCOMPARE(code->property("text").toString(), QString("123456"));
    }
    void changedActivationContextResetsDrafts_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("relay") << "relay";
        QTest::newRow("host") << "host";
        QTest::newRow("saved-mailbox") << "email";
    }
    void changedActivationContextResetsDrafts() {
        // HOST-ACT-13: preserve normal edits but never submit a previous Relay,
        // Host or recovered mailbox's verification code in a new context.
        QFETCH(QString, change);
        RegistrationHost host;
        QQmlEngine engine; auto view = create(engine, host); QVERIFY(view);
        auto *window = qobject_cast<QQuickWindow *>(view.get()); QVERIFY(window);
        auto *email = view->findChild<QQuickItem *>("registrationEmail"); QVERIFY(email);
        auto *code = view->findChild<QQuickItem *>("verificationCode"); QVERIFY(code);
        type(window, email, "draft@qq.com"); type(window, code, "123456");
        if (change == "relay") host.relayUrl = "wss://relay-b.example";
        else if (change == "host") host.hostId = "host-b";
        else host.email = "recovered@qq.com";
        emit host.changed();
        QCOMPARE(email->property("text").toString(), host.email);
        QCOMPARE(code->property("text").toString(), QString());
    }
};
QTEST_MAIN(RegistrationInputTest)
#include "RegistrationInputTest.moc"
