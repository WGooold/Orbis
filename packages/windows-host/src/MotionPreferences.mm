#include "MotionPreferences.h"
#import <AppKit/AppKit.h>
bool systemMotionEnabled() { return !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion; }
