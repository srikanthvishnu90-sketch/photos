import Foundation
import Capacitor
import Photos
import UIKit

// GemsPhotos — a Capacitor plugin that reads the user's photo library ON DEVICE
// via PhotoKit and streams it to the web app in downscaled batches, so Gems can
// analyze the whole camera roll. Photos never leave the phone; only the app's
// own edit exports (elsewhere) are ever uploaded.
//
// JS contract (see gems-native.js):
//   requestAccess()                       -> { status: "granted" | "limited" | "denied" }
//   count()                               -> { count: Int }
//   getBatch({ offset, limit, maxEdge })  -> { photos: [{ id, mimeType, base64 }] }
@objc(GemsPhotosPlugin)
public class GemsPhotosPlugin: CAPPlugin {

    // Newest-first image assets. Rebuilt per call so a freshly granted or
    // changed library is always reflected.
    private func fetchImages() -> PHFetchResult<PHAsset> {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeHiddenAssets = false
        return PHAsset.fetchAssets(with: .image, options: options)
    }

    private func statusString(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .limited: return "limited"
        default: return "denied"
        }
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
            let value = self?.statusString(status) ?? "denied"
            DispatchQueue.main.async {
                call.resolve(["status": value])
            }
        }
    }

    @objc func count(_ call: CAPPluginCall) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            call.resolve(["count": 0])
            return
        }
        let total = fetchImages().count
        call.resolve(["count": total])
    }

    @objc func getBatch(_ call: CAPPluginCall) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            call.resolve(["photos": []])
            return
        }

        let offset = call.getInt("offset") ?? 0
        let limit = call.getInt("limit") ?? 40
        let maxEdge = CGFloat(call.getInt("maxEdge") ?? 1600)

        let assets = fetchImages()
        let totalCount = assets.count
        if offset >= totalCount {
            call.resolve(["photos": []])
            return
        }
        let end = min(offset + limit, totalCount)

        // Collect the slice in order.
        var slice: [PHAsset] = []
        for index in offset..<end {
            slice.append(assets.object(at: index))
        }

        let manager = PHImageManager.default()
        let requestOptions = PHImageRequestOptions()
        requestOptions.isSynchronous = false
        requestOptions.deliveryMode = .highQualityFormat
        requestOptions.resizeMode = .fast
        requestOptions.isNetworkAccessAllowed = true // fetch iCloud originals if needed

        // Preserve input order even though requests complete out of order.
        var results = [String: [String: Any]]()
        let group = DispatchGroup()

        for asset in slice {
            let targetSize = CGSize(width: maxEdge, height: maxEdge)
            group.enter()
            manager.requestImage(
                for: asset,
                targetSize: targetSize,
                contentMode: .aspectFit,
                options: requestOptions
            ) { image, info in
                // requestImage may call back more than once (a low-res
                // placeholder then the full image). Only finish on the final,
                // non-degraded delivery.
                let isDegraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                if isDegraded { return }
                defer { group.leave() }
                guard let image = image,
                      let data = image.jpegData(compressionQuality: 0.82) else {
                    return
                }
                results[asset.localIdentifier] = [
                    "id": asset.localIdentifier,
                    "mimeType": "image/jpeg",
                    "base64": data.base64EncodedString()
                ]
            }
        }

        group.notify(queue: .main) {
            // Emit in the original newest-first slice order, skipping any that
            // failed to render.
            let ordered = slice.compactMap { results[$0.localIdentifier] }
            call.resolve(["photos": ordered])
        }
    }
}
