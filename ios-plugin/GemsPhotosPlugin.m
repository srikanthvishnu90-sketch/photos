#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift GemsPhotosPlugin with Capacitor's bridge and exposes its
// three async methods to JavaScript as `Capacitor.Plugins.GemsPhotos`.
// The JS contract lives in gems-native.js.
CAP_PLUGIN(GemsPhotosPlugin, "GemsPhotos",
  CAP_PLUGIN_METHOD(requestAccess, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(count, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(getBatch, CAPPluginReturnPromise);
)
