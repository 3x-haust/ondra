// bgguard: loaded (via DYLD_INSERT_LIBRARIES) into an app cuhost starts for background
// work. It keeps the app a background app: the app can't turn itself into a regular
// (Dock) app or bring itself to the front. Nothing else about the app changes.
//
// This loads only into an app that cannot enforce it away: a non-hardened app, or a
// hardened app that ships allow-dyld-environment-variables with disable-library-
// validation. cuhost checks that before injecting; otherwise it leaves the app alone
// and falls back to a reactive front-guard (giveFrontBack).
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdlib.h>

static BOOL (*origSetPolicy)(id, SEL, NSApplicationActivationPolicy);
static BOOL guardSetPolicy(id self, SEL _cmd, NSApplicationActivationPolicy p) { return p == NSApplicationActivationPolicyRegular ? YES : origSetPolicy(self, _cmd, p); }
static void noActivateFlag(id self, SEL _cmd, BOOL flag) {}
static void noActivate(id self, SEL _cmd) {}
static BOOL (*origRunningActivate)(id, SEL, NSApplicationActivationOptions);
static BOOL guardRunningActivate(id self, SEL _cmd, NSApplicationActivationOptions o) { return [self processIdentifier] == getpid() ? NO : origRunningActivate(self, _cmd, o); }

static OSStatus guardTransform(const ProcessSerialNumber *psn, UInt32 type) { return noErr; }
static OSStatus guardSetFront(const ProcessSerialNumber *psn) { return noErr; }
__attribute__((used)) static const struct { const void *replacement, *replacee; } interposers[] __attribute__((section("__DATA,__interpose"))) = {
  { (const void *)guardTransform, (const void *)TransformProcessType },
  { (const void *)guardSetFront, (const void *)SetFrontProcess },
};

static void swap(Class c, SEL s, IMP imp, IMP *orig) { Method m = class_getInstanceMethod(c, s); if (!m) return; IMP o = method_setImplementation(m, imp); if (orig) *orig = o; }

__attribute__((constructor)) static void start(void) {
  unsetenv("DYLD_INSERT_LIBRARIES");  // the app's own child processes start clean
  Class app = objc_getClass("NSApplication");
  swap(app, @selector(setActivationPolicy:), (IMP)guardSetPolicy, (IMP *)&origSetPolicy);
  swap(app, @selector(activateIgnoringOtherApps:), (IMP)noActivateFlag, NULL);
  swap(app, NSSelectorFromString(@"activate"), (IMP)noActivate, NULL);
  swap(objc_getClass("NSRunningApplication"), @selector(activateWithOptions:), (IMP)guardRunningActivate, (IMP *)&origRunningActivate);
}
