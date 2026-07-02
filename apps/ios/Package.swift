// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "MoodarrIOS",
  platforms: [
    .iOS(.v17),
    .macOS(.v14)
  ],
  products: [
    .library(name: "MoodarrIOS", targets: ["MoodarrIOS"])
  ],
  targets: [
    .target(name: "MoodarrIOS"),
    .testTarget(name: "MoodarrIOSTests", dependencies: ["MoodarrIOS"])
  ]
)
