// bgguard: loaded (via DYLD_INSERT_LIBRARIES) into an app cuhost starts for background
// work. It keeps the app a background app: the app can't turn itself into a regular
// (Dock) app or bring itself to the front. Nothing else about the app changes.
//
// This loads only into an app that cannot enforce it away: a non-hardened app, or a
// hardened app that ships allow-dyld-environment-variables with disable-library-
// validation. cuhost checks that before injecting; otherwise it leaves the app alone
// and falls back to a reactive front-guard (giveFrontBack).
//
// It also carries drag and drop out inside the app. A system drag follows the real
// pointer, so a drag Ondra posts to the app starts but can never drop. When a drag
// begins from one of Ondra's events (they carry ONDRA_MARK), the drag runs here
// instead: the dragged items go on a private pasteboard, Ondra's following events
// move the drag over the app's own drop targets, and the release drops it, through
// the same source and destination calls AppKit makes. Drags the user makes are untouched.
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

// ───────────── drag and drop inside the app ─────────────

#define ONDRA_MARK 0x4F4E4452  // kCGEventSourceUserData on every mouse event cuhost posts

static BOOL fromOndra(NSEvent *e) {
  CGEventRef c = e ? [e CGEvent] : NULL;
  return c && CGEventGetIntegerValueField(c, kCGEventSourceUserData) == ONDRA_MARK;
}

@interface OndraDragSession : NSDraggingSession
@property(strong) NSPasteboard *pb;
@property NSPoint at;
@property NSInteger seq;
@end
@implementation OndraDragSession
- (NSPasteboard *)draggingPasteboard { return self.pb; }
- (NSPoint)draggingLocation { return self.at; }
- (NSInteger)draggingSequenceNumber { return self.seq; }
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)o forView:(NSView *)v classes:(NSArray *)c searchOptions:(NSDictionary *)so usingBlock:(void (NS_NOESCAPE ^)(NSDraggingItem *, NSInteger, BOOL *))b {}
@end

// What the drop target sees, as NSDraggingInfo.
@interface OndraDragInfo : NSObject <NSDraggingInfo>
@property(weak) NSWindow *win;
@property NSPoint at;  // window coordinates
@property(strong) NSPasteboard *pb;
@property(weak) id source;
@property NSDragOperation mask;
@property NSInteger seq;
@property NSDraggingFormation draggingFormation;
@property BOOL animatesToDestination;
@property NSInteger numberOfValidItemsForDrop;
@property(readonly) NSSpringLoadingHighlight springLoadingHighlight;
@end
@implementation OndraDragInfo
- (NSWindow *)draggingDestinationWindow { return self.win; }
- (NSDragOperation)draggingSourceOperationMask { return self.mask; }
- (NSPoint)draggingLocation { return self.at; }
- (NSPoint)draggedImageLocation { return self.at; }
- (NSImage *)draggedImage { return nil; }
- (NSPasteboard *)draggingPasteboard { return self.pb; }
- (id)draggingSource { return self.source; }
- (NSInteger)draggingSequenceNumber { return self.seq; }
- (void)slideDraggedImageTo:(NSPoint)p {}
- (NSArray<NSString *> *)namesOfPromisedFilesDroppedAtDestination:(NSURL *)u { return nil; }
- (NSSpringLoadingHighlight)springLoadingHighlight { return NSSpringLoadingHighlightNone; }
- (void)resetSpringLoading {}
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)o forView:(NSView *)v classes:(NSArray<Class> *)classes searchOptions:(NSDictionary *)so usingBlock:(void (NS_NOESCAPE ^)(NSDraggingItem *, NSInteger, BOOL *))block {
  BOOL stop = NO;
  NSArray *objs = [self.pb readObjectsForClasses:classes options:so];
  for (NSInteger i = 0; i < (NSInteger)objs.count && !stop; i++) block([[NSDraggingItem alloc] initWithPasteboardWriter:objs[i]], i, &stop);
}
// A destination may ask for something private; answer nothing rather than crash the app.
- (NSMethodSignature *)methodSignatureForSelector:(SEL)s { return [super methodSignatureForSelector:s] ?: [NSMethodSignature signatureWithObjCTypes:"@@:"]; }
- (void)forwardInvocation:(NSInvocation *)inv {}
@end

static NSDragOperation pickOp(NSDragOperation mask) {
  for (NSDragOperation o = NSDragOperationCopy; o <= NSDragOperationDelete; o <<= 1) if (mask & o) return o;
  return NSDragOperationNone;
}

// The topmost view under the point that takes one of the pasteboard's types.
static id dropTarget(NSWindow *w, NSPoint at, NSArray *types) {
  NSView *frame = w.contentView.superview ?: w.contentView;
  for (NSView *v = [frame hitTest:at]; v; v = v.superview)
    if ([v.registeredDraggedTypes firstObjectCommonWithArray:types]) return v;
  return nil;
}

static BOOL dragging = NO;

// Follows Ondra's dragged events to the release. `moved` and `ended` get screen points.
static void runDrag(NSWindow *win, NSPoint start, NSPasteboard *pb, id source, NSDragOperation mask, NSInteger seq,
                    void (^moved)(NSPoint), void (^ended)(NSPoint, NSDragOperation)) {
  dragging = YES;
  OndraDragInfo *info = [OndraDragInfo new];
  info.pb = pb; info.source = source; info.mask = mask; info.seq = seq;
  info.win = win; info.at = start;
  info.numberOfValidItemsForDrop = MAX(1, (NSInteger)pb.pasteboardItems.count);
  id target = nil;
  NSDragOperation op = NSDragOperationNone;
  NSArray *types = pb.types ?: @[];
  NSDate *giveUp = [NSDate dateWithTimeIntervalSinceNow:3];
  for (;;) {
    NSEvent *e = [NSApp nextEventMatchingMask:NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp
                                    untilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]
                                       inMode:NSEventTrackingRunLoopMode dequeue:YES];
    if (!e) {
      if (giveUp.timeIntervalSinceNow > 0) continue;
      if (target && [target respondsToSelector:@selector(draggingExited:)]) [target draggingExited:info];
      ended([info.win convertPointToScreen:info.at], NSDragOperationNone);
      break;
    }
    giveUp = [NSDate dateWithTimeIntervalSinceNow:3];
    NSWindow *w = e.window ?: [NSApp windowWithWindowNumber:e.windowNumber] ?: info.win;
    info.win = w; info.at = e.locationInWindow;
    id t = dropTarget(w, info.at, types);
    if (t != target) {
      if (target && [target respondsToSelector:@selector(draggingExited:)]) [target draggingExited:info];
      target = t;
      op = !target ? NSDragOperationNone
         : [target respondsToSelector:@selector(draggingEntered:)] ? [target draggingEntered:info] : pickOp(mask);
    } else if (target && [target respondsToSelector:@selector(draggingUpdated:)]) {
      op = [target draggingUpdated:info];
    }
    NSPoint screen = [w convertPointToScreen:info.at];
    moved(screen);
    if (e.type != NSEventTypeLeftMouseUp) continue;
    BOOL done = NO;
    if (target && (op & mask)) {
      BOOL ready = ![target respondsToSelector:@selector(prepareForDragOperation:)] || [target prepareForDragOperation:info];
      done = ready && [target respondsToSelector:@selector(performDragOperation:)] && [target performDragOperation:info];
      if (done && [target respondsToSelector:@selector(concludeDragOperation:)]) [target concludeDragOperation:info];
    } else if (target && [target respondsToSelector:@selector(draggingExited:)]) {
      [target draggingExited:info];
    }
    ended(screen, done ? (op & mask) : NSDragOperationNone);
    break;
  }
  [pb releaseGlobally];
  dragging = NO;
}

static NSDraggingSession *(*origBegin)(id, SEL, NSArray *, NSEvent *, id);
static NSDraggingSession *ondraBegin(NSView *self, SEL _cmd, NSArray<NSDraggingItem *> *items, NSEvent *event, id<NSDraggingSource> source) {
  if (dragging || !(fromOndra(event) || fromOndra(NSApp.currentEvent)) || !self.window) return origBegin(self, _cmd, items, event, source);
  NSPasteboard *pb = [NSPasteboard pasteboardWithUniqueName];
  [pb clearContents];
  NSMutableArray *writers = [NSMutableArray array];
  for (NSDraggingItem *i in items) if (i.item) [writers addObject:i.item];
  [pb writeObjects:writers];
  OndraDragSession *s = [OndraDragSession new];
  s.pb = pb; s.seq = (NSInteger)arc4random();
  NSWindow *win = self.window;
  NSPoint start = event ? event.locationInWindow : [win mouseLocationOutsideOfEventStream];
  s.at = [win convertPointToScreen:start];
  // like AppKit, the drag starts once the event that began it is handled
  [[NSRunLoop mainRunLoop] performInModes:@[NSDefaultRunLoopMode] block:^{
    if ([source respondsToSelector:@selector(draggingSession:willBeginAtPoint:)]) [source draggingSession:s willBeginAtPoint:s.at];
    NSDragOperation mask = [source draggingSession:s sourceOperationMaskForDraggingContext:NSDraggingContextWithinApplication];
    runDrag(win, start, pb, source, mask, s.seq,
      ^(NSPoint p) { s.at = p; if ([source respondsToSelector:@selector(draggingSession:movedToPoint:)]) [source draggingSession:s movedToPoint:p]; },
      ^(NSPoint p, NSDragOperation op) { s.at = p; if ([source respondsToSelector:@selector(draggingSession:endedAtPoint:operation:)]) [source draggingSession:s endedAtPoint:p operation:op]; });
  }];
  return s;
}

// The older drag call, which returns only after the drop.
typedef void (*DragImageFn)(id, SEL, NSImage *, NSPoint, NSSize, NSEvent *, NSPasteboard *, id, BOOL);
static DragImageFn origViewDragImage, origWindowDragImage;
static BOOL legacyDrag(NSWindow *win, NSPoint start, NSPasteboard *src, id source, NSEvent *event) {
  if (dragging || !win || !(fromOndra(event) || fromOndra(NSApp.currentEvent))) return NO;
  NSPasteboard *pb = [NSPasteboard pasteboardWithUniqueName];
  [pb clearContents];
  for (NSPasteboardType t in src.types ?: @[]) { NSData *d = [src dataForType:t]; if (d) { [pb addTypes:@[t] owner:nil]; [pb setData:d forType:t]; } }
  #pragma clang diagnostic push
  #pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSDragOperation mask = [source respondsToSelector:@selector(draggingSourceOperationMaskForLocal:)] ? [source draggingSourceOperationMaskForLocal:YES] : NSDragOperationEvery;
  runDrag(win, start, pb, source, mask, (NSInteger)arc4random(), ^(NSPoint p) {},
    ^(NSPoint p, NSDragOperation op) { if ([source respondsToSelector:@selector(draggedImage:endedAt:operation:)]) [source draggedImage:nil endedAt:p operation:op]; });
  #pragma clang diagnostic pop
  return YES;
}
static void ondraViewDragImage(NSView *self, SEL c, NSImage *img, NSPoint at, NSSize off, NSEvent *e, NSPasteboard *pb, id src, BOOL slide) {
  if (!legacyDrag(self.window, e ? e.locationInWindow : [self convertPoint:at toView:nil], pb, src, e)) origViewDragImage(self, c, img, at, off, e, pb, src, slide);
}
static void ondraWindowDragImage(NSWindow *self, SEL c, NSImage *img, NSPoint at, NSSize off, NSEvent *e, NSPasteboard *pb, id src, BOOL slide) {
  if (!legacyDrag(self, e ? e.locationInWindow : at, pb, src, e)) origWindowDragImage(self, c, img, at, off, e, pb, src, slide);
}

static void swap(Class c, SEL s, IMP imp, IMP *orig) { Method m = class_getInstanceMethod(c, s); if (!m) return; IMP o = method_setImplementation(m, imp); if (orig) *orig = o; }

__attribute__((constructor)) static void start(void) {
  unsetenv("DYLD_INSERT_LIBRARIES");  // the app's own child processes start clean
  Class app = objc_getClass("NSApplication");
  swap(app, @selector(setActivationPolicy:), (IMP)guardSetPolicy, (IMP *)&origSetPolicy);
  swap(app, @selector(activateIgnoringOtherApps:), (IMP)noActivateFlag, NULL);
  swap(app, NSSelectorFromString(@"activate"), (IMP)noActivate, NULL);
  swap(objc_getClass("NSRunningApplication"), @selector(activateWithOptions:), (IMP)guardRunningActivate, (IMP *)&origRunningActivate);
  swap(objc_getClass("NSView"), @selector(beginDraggingSessionWithItems:event:source:), (IMP)ondraBegin, (IMP *)&origBegin);
  SEL di = @selector(dragImage:at:offset:event:pasteboard:source:slideBack:);
  swap(objc_getClass("NSView"), di, (IMP)ondraViewDragImage, (IMP *)&origViewDragImage);
  swap(objc_getClass("NSWindow"), di, (IMP)ondraWindowDragImage, (IMP *)&origWindowDragImage);
}
