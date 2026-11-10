#!/bin/bash
# Builds dist/gnome-cpu-ram-usage_<version>_all.deb
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-1.3.0}"
MAINTAINER="eternalthiago-netizen <322351893+eternalthiago-netizen@users.noreply.github.com>"
BUILD=build
rm -rf "$BUILD" && mkdir -p "$BUILD" dist

P="$BUILD/gnome-cpu-ram-usage"
mkdir -p "$P/usr/share/gnome-shell/extensions"
cp -r cpu-ram-usage@local "$P/usr/share/gnome-shell/extensions/"
mkdir -p "$P/DEBIAN"
cat > "$P/DEBIAN/control" <<EOF
Package: gnome-cpu-ram-usage
Version: $VERSION
Architecture: all
Maintainer: $MAINTAINER
Depends: gnome-shell (>= 45)
Section: gnome
Priority: optional
Description: CPU/RAM usage, CPU/GPU temperatures and disk activity in the GNOME top bar
 Shows CPU and RAM usage, CPU/GPU temperatures and disk activity and
 read/write speed in the top bar, with
 colors for high values; the menu chooses what is shown. Reads /proc and
 /sys directly; uses nvidia-smi for NVIDIA GPUs.
EOF
cat > "$P/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
echo "Enable with: gnome-extensions enable cpu-ram-usage@local  (then restart GNOME Shell)"
EOF
chmod 755 "$P/DEBIAN/postinst"

# Standard package permissions: 755 dirs/executables, 644 other files
chmod -R u=rwX,go=rX "$BUILD"

dpkg-deb --root-owner-group --build "$P" "dist/gnome-cpu-ram-usage_${VERSION}_all.deb"
rm -rf "$BUILD"
