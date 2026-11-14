import QuickLook
import RoomPlan
import SwiftUI

/// Room scans with the iPhone's LiDAR (Apple RoomPlan): walk a space, get its walls, doors and
/// windows as a 3D model, plus the numbers a site visit needs, like ceiling (clear) height.
/// The Tello has no LiDAR; this uses the phone.
struct LiDARScanView: View {
  @State private var scans = SavedScan.all()
  @State private var scanning = false
  @State private var preview: URL?

  var body: some View {
    if !RoomCaptureSession.isSupported {
      ContentUnavailableView(
        "LiDAR needed", systemImage: "camera.metering.unknown",
        description: Text("Room scanning uses the LiDAR sensor in iPhone Pro models (12 Pro and later). It isn't available on this device or in the simulator.")
      )
    } else {
      List {
        Section {
          VStack(alignment: .leading, spacing: 10) {
            Label("Scan a room with LiDAR", systemImage: "cube.transparent")
              .font(.headline)
            Text("Walk the space slowly and point the phone at every wall, the floor and the ceiling. You get a 3D model and its measurements: ceiling (clear) height, floor area, walls, doors and windows.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
            Button {
              scanning = true
            } label: {
              Label("Start scan", systemImage: "viewfinder")
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
          }
          .padding(.vertical, 6)
        }
        if !scans.isEmpty {
          Section("Saved scans") {
            ForEach(scans) { scan in
              ScanRow(scan: scan) { preview = scan.modelURL }
            }
            .onDelete { offsets in
              for i in offsets { scans[i].delete() }
              scans.remove(atOffsets: offsets)
            }
          }
        }
        Section {
          Text("RoomPlan is built for rooms up to about 9 m (30 ft) across. In a warehouse, scan offices, electrical rooms and single bays. Measurements are estimates; confirm critical ones with a tape or laser.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .scrollContentBackground(.hidden)
      .fullScreenCover(isPresented: $scanning) {
        RoomScanScreen { scans.insert($0, at: 0) }
      }
      .quickLookPreview($preview)
    }
  }
}

private struct ScanRow: View {
  let scan: SavedScan
  let view3D: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(scan.date.formatted(date: .abbreviated, time: .shortened)).font(.headline)
        Spacer()
        Button("3D", systemImage: "cube", action: view3D)
          .buttonStyle(.bordered)
          .controlSize(.small)
        ShareLink(item: scan.modelURL) { Image(systemName: "square.and.arrow.up") }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
        GridRow {
          fact("Ceiling height", scan.ceilingHeight.map { metres($0, feet: true) } ?? "–")
          fact("Floor area", scan.floorArea.map { String(format: "%.0f m² · %.0f sq ft", $0, $0 * 10.7639) } ?? "–")
        }
        GridRow {
          fact("Walls", "\(scan.walls) · \(metres(scan.wallLength, feet: false)) total")
          fact("Doors · windows", "\(scan.doors) · \(scan.windows)")
        }
      }
      if !scan.objects.isEmpty {
        Text(scan.objects.sorted { $0.value > $1.value }.prefix(4).map { "\($0.value) \($0.key)" }.joined(separator: " · "))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
  }

  private func fact(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      Text(value).font(.subheadline.weight(.semibold))
    }
  }

  private func metres(_ m: Double, feet: Bool) -> String {
    feet ? String(format: "%.2f m · %.1f ft", m, m * 3.28084) : String(format: "%.1f m", m)
  }
}

// MARK: - Capture

/// Full-screen RoomPlan capture: scan, tap Done to process, then Save.
private struct RoomScanScreen: View {
  let onSaved: (SavedScan) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var controller = RoomScanController()
  @State private var saveError: String?

  var body: some View {
    ZStack(alignment: .top) {
      RoomCaptureContainer(controller: controller)
        .ignoresSafeArea()
        .onAppear { controller.start() }
      HStack {
        Button("Cancel") {
          controller.stop()
          dismiss()
        }
        .buttonStyle(.bordered)
        Spacer()
        if controller.result != nil {
          Button("Save", action: save).buttonStyle(.borderedProminent)
        } else {
          Button(controller.finishing ? "Processing…" : "Done") { controller.stop() }
            .buttonStyle(.borderedProminent)
            .disabled(controller.finishing)
        }
      }
      .controlSize(.large)
      .padding(.horizontal, 16)
      .padding(.top, 8)
    }
    .alert("Couldn't save the scan", isPresented: .constant(saveError != nil || controller.failure != nil)) {
      Button("OK") {
        saveError = nil
        controller.failure = nil
      }
    } message: {
      Text(saveError ?? controller.failure ?? "")
    }
  }

  private func save() {
    guard let room = controller.result else { return }
    do {
      let scan = SavedScan(room: room)
      try FileManager.default.createDirectory(at: SavedScan.folder, withIntermediateDirectories: true)
      try room.export(to: scan.modelURL, exportOptions: .parametric)
      try scan.save()
      onSaved(scan)
      dismiss()
    } catch {
      saveError = error.localizedDescription
    }
  }
}

private struct RoomCaptureContainer: UIViewRepresentable {
  let controller: RoomScanController
  func makeUIView(context: Context) -> RoomCaptureView { controller.view }
  func updateUIView(_ view: RoomCaptureView, context: Context) {}
}

@Observable
final class RoomScanController {
  let view = RoomCaptureView(frame: .zero)
  fileprivate(set) var result: CapturedRoom?
  fileprivate(set) var finishing = false
  var failure: String?
  private let delegate = Delegate()
  private var running = false

  init() {
    delegate.owner = self
    view.delegate = delegate
  }

  func start() {
    guard !running else { return }
    running = true
    view.captureSession.run(configuration: RoomCaptureSession.Configuration())
  }

  /// Ends capture; RoomPlan then processes the scan and shows the finished model.
  func stop() {
    guard running else { return }
    running = false
    finishing = true
    view.captureSession.stop()
  }

  @objc(PlotStarRoomCaptureDelegate)
  final class Delegate: NSObject, @preconcurrency RoomCaptureViewDelegate {
    weak var owner: RoomScanController?

    override init() { super.init() }
    // RoomCaptureViewDelegate inherits NSCoding; there is nothing to archive.
    required init?(coder: NSCoder) { super.init() }
    func encode(with coder: NSCoder) {}

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: (any Error)?) -> Bool { true }

    func captureView(didPresent processedResult: CapturedRoom, error: (any Error)?) {
      owner?.finishing = false
      if let error { owner?.failure = error.localizedDescription }
      owner?.result = processedResult
    }
  }
}

// MARK: - Saved scans

/// A scan on this phone: the USDZ model plus a JSON summary, in Documents/Scans.
struct SavedScan: Codable, Identifiable {
  let id: String
  let date: Date
  let walls: Int
  let doors: Int
  let windows: Int
  let openings: Int
  let objects: [String: Int]
  /// Tallest wall, in metres: the room's ceiling (clear) height.
  let ceilingHeight: Double?
  /// Square metres, from the floor outline.
  let floorArea: Double?
  /// Metres of wall.
  let wallLength: Double

  static var folder: URL { URL.documentsDirectory.appending(path: "Scans", directoryHint: .isDirectory) }
  var modelURL: URL { Self.folder.appending(path: "\(id).usdz") }
  private var infoURL: URL { Self.folder.appending(path: "\(id).json") }

  static func all() -> [SavedScan] {
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" }
      .compactMap { try? JSONDecoder().decode(SavedScan.self, from: Data(contentsOf: $0)) }
      .sorted { $0.date > $1.date }
  }

  func save() throws { try JSONEncoder().encode(self).write(to: infoURL) }

  func delete() {
    try? FileManager.default.removeItem(at: modelURL)
    try? FileManager.default.removeItem(at: infoURL)
  }
}

extension SavedScan {
  init(room: CapturedRoom) {
    let now = Date.now
    id = "scan-" + now.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false)).replacingOccurrences(of: ":", with: "")
    date = now
    walls = room.walls.count
    doors = room.doors.count
    windows = room.windows.count
    openings = room.openings.count
    objects = Dictionary(grouping: room.objects) { String(describing: $0.category) }.mapValues(\.count)
    ceilingHeight = room.walls.map { Double($0.dimensions.y) }.max()
    wallLength = room.walls.reduce(0) { $0 + Double($1.dimensions.x) }
    let area = room.floors.map(Self.area).reduce(0, +)
    floorArea = area > 0 ? area : nil
  }

  /// The floor polygon's area, on whichever two axes its corners spread across.
  private static func area(_ surface: CapturedRoom.Surface) -> Double {
    let corners = surface.polygonCorners
    guard corners.count >= 3 else { return Double(surface.dimensions.x * surface.dimensions.y) }
    let spread = (0..<3).map { axis in
      (corners.map { $0[axis] }.max() ?? 0) - (corners.map { $0[axis] }.min() ?? 0)
    }
    let axes = (0..<3).sorted { spread[$0] > spread[$1] }
    let (a, b) = (axes[0], axes[1])
    var sum: Float = 0
    for i in corners.indices {
      let p = corners[i], q = corners[(i + 1) % corners.count]
      sum += p[a] * q[b] - q[a] * p[b]
    }
    return Double(abs(sum) / 2)
  }
}
