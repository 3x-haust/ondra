// Private CoreGraphics virtual-display classes, declared so cuhost.swift can make
// one off-screen display to hold background windows. These are long-standing public
// ObjC classes inside CoreGraphics (used by screen-sharing and sidecar); only their
// headers are private. No private entitlement is needed to instantiate them.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property (retain, nullable) dispatch_queue_t queue;
@property (retain, nullable) NSString *name;
@property unsigned int maxPixelsWide, maxPixelsHigh, productID, vendorID, serialNum;
@property CGSize sizeInMillimeters;
@property (copy, nullable) void (^terminationHandler)(id _Nullable, id _Nullable);
@end

@interface CGVirtualDisplayMode : NSObject
- (nonnull instancetype)initWithWidth:(unsigned int)w height:(unsigned int)h refreshRate:(double)r;
@end

@interface CGVirtualDisplaySettings : NSObject
@property unsigned int hiDPI;
@property (retain, nullable) NSArray<CGVirtualDisplayMode *> *modes;
@end

@interface CGVirtualDisplay : NSObject
- (nullable instancetype)initWithDescriptor:(nonnull CGVirtualDisplayDescriptor *)d;
- (BOOL)applySettings:(nonnull CGVirtualDisplaySettings *)s;
@property (readonly) CGDirectDisplayID displayID;
@end
