#!/bin/sh
# Rasterize branding/rolltop-logo.svg into the Firefox fork's branding directory.
# macOS only: uses sips, iconutil and Xcode's actool, plus ImageMagick (magick).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
fork=${ROLLTOP_FIREFOX:-$here/../../rolltop-browser}
out=$fork/browser/branding/rolltop
svg=$here/rolltop-logo.svg
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

[ -d "$out" ] || { echo "missing $out" >&2; exit 1; }

sips -s format png "$svg" --out "$tmp/1024.png" >/dev/null
png() { magick "$tmp/1024.png" -resize "$1x$1" "$2"; }

# Window and content icons.
for s in 16 22 24 32 48 64 128 256; do png $s "$out/default$s.png"; done
png 192 "$out/content/about-logo.png"
png 384 "$out/content/about-logo@2x.png"
png 192 "$out/content/about-logo-private.png"
png 384 "$out/content/about-logo-private@2x.png"
magick "$tmp/1024.png" -resize 236x236 -background none -gravity center -extent 300x236 "$out/content/about.png"
cp "$svg" "$out/content/about-logo.svg"

# macOS: firefox.icns for older systems, Assets.car (AppIcon) for current ones.
set_dir=$tmp/Assets.xcassets/AppIcon.appiconset
mkdir -p "$set_dir" "$tmp/car"
images=""
for s in 16 32 128 256 512; do
  png $s "$set_dir/$s.png"
  png $((s * 2)) "$set_dir/$s@2x.png"
  images="$images{\"idiom\":\"mac\",\"size\":\"${s}x${s}\",\"scale\":\"1x\",\"filename\":\"$s.png\"},"
  images="$images{\"idiom\":\"mac\",\"size\":\"${s}x${s}\",\"scale\":\"2x\",\"filename\":\"$s@2x.png\"},"
done
printf '{"images":[%s],"info":{"version":1,"author":"xcode"}}' "${images%,}" > "$set_dir/Contents.json"
printf '{"info":{"version":1,"author":"xcode"}}' > "$tmp/Assets.xcassets/Contents.json"
xcrun actool --compile "$tmp/car" --platform macosx --minimum-deployment-target 10.15 \
  --app-icon AppIcon --output-partial-info-plist "$tmp/partial.plist" \
  "$tmp/Assets.xcassets" >/dev/null 2>"$tmp/actool.log" || { cat "$tmp/actool.log" >&2; exit 1; }
cp "$tmp/car/Assets.car" "$out/Assets.car"
cp "$tmp/car/AppIcon.icns" "$out/firefox.icns"

# Windows icons and tiles.
magick "$tmp/1024.png" -define icon:auto-resize=256,64,48,32,24,16 "$out/firefox.ico"
magick "$tmp/1024.png" -define icon:auto-resize=256,64,48,32,24,16 "$out/firefox64.ico"
png 300 "$out/VisualElements_150.png"
png 142 "$out/VisualElements_70.png"

echo "Wrote branding to $out"
