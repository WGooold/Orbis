#include "MotionPreferences.h"
#include <QtGlobal>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif
#ifndef Q_OS_MACOS
bool systemMotionEnabled() {
#ifdef Q_OS_WIN
    BOOL enabled = TRUE;
    return !SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0) || enabled;
#else
    return true;
#endif
}
#endif
