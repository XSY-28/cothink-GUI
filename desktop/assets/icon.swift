// Convert the user-provided square artwork without cropping or redrawing it.
// Run with swift icon.swift <output.png>; source bytes live beside this file.
import AppKit
let sourceURL=URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("icon-source.png")
guard CommandLine.arguments.count == 2, let source=NSImage(contentsOf:sourceURL), source.size.width == source.size.height else {
    fatalError("Expected square icon-source.png and one output PNG path")
}
let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:1024,pixelsHigh:1024,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
NSGraphicsContext.current?.imageInterpolation = .high
source.draw(in:NSRect(x:0,y:0,width:1024,height:1024))
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
