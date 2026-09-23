#!/usr/bin/env bash
# Download the self-hosted fonts and subset them to woff2 in public/fonts/.
# All OFL. Urdu faces are subset to the Arabic blocks so Latin falls through to Inter.
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/fonts; tmp=$(mktemp -d); mkdir -p "$out"
ARABIC='U+0600-06FF,U+0750-077F,U+0870-088E,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFC,U+200C-200F,U+2010-2011,U+00A0,U+060C,U+061B,U+061F'
LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
sub() { uv tool run --python 3.12 --from 'fonttools[woff,unicode]' pyftsubset "$@"; }
asset() { # $1 repo, $2 python filter expr on asset name
  curl -sS "https://api.github.com/repos/$1/releases?per_page=20" | python3 -c "
import sys,json
for r in json.load(sys.stdin):
  for a in r.get('assets',[]):
    n=a['name']
    if $2: print(a['browser_download_url']); raise SystemExit"
}

echo "1. Noto Nastaliq Urdu v4 (GitHub release; Google Fonts still serves 3.009)"
url=$(asset notofonts/nastaliq "n.startswith('NotoNastaliqUrdu-v4') and n.endswith('.zip')")
echo "   $url"; curl -sSL "$url" -o "$tmp/nastaliq.zip"; unzip -qo "$tmp/nastaliq.zip" -d "$tmp/nastaliq"
ttf=$(find "$tmp/nastaliq" -name 'NotoNastaliqUrdu\[wght\].ttf' | head -1)
sub "$ttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/NotoNastaliqUrdu[wght].woff2"

echo "2. Noto Naskh Arabic (google/fonts main)"
curl -sSL 'https://github.com/google/fonts/raw/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf' -o "$tmp/naskh.ttf"
sub "$tmp/naskh.ttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/NotoNaskhArabic[wght].woff2"

echo "3. Vazirmatn (UI)"
url=$(asset rastikerdar/vazirmatn "n.endswith('.zip')")
echo "   $url"; curl -sSL "$url" -o "$tmp/vazir.zip"; unzip -qo "$tmp/vazir.zip" -d "$tmp/vazir"
vttf=$(find "$tmp/vazir" -name 'Vazirmatn\[wght\].ttf' | head -1)
sub "$vttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/Vazirmatn[wght].woff2"

echo "4. Inter (English body/UI)"
url=$(asset rsms/inter "n.startswith('Inter-') and n.endswith('.zip')")
echo "   $url"; curl -sSL "$url" -o "$tmp/inter.zip"; unzip -qo "$tmp/inter.zip" -d "$tmp/inter"
sub "$(find "$tmp/inter" -name "InterVariable.woff2" | head -1)" --flavor=woff2 --layout-features="*" --unicodes="$LATIN" --output-file="$out/InterVariable.woff2"
sub "$(find "$tmp/inter" -name "InterVariable-Italic.woff2" | head -1)" --flavor=woff2 --layout-features="*" --unicodes="$LATIN" --output-file="$out/InterVariable-Italic.woff2"

echo "5. Newsreader (English headlines, Classic theme)"
curl -sSL 'https://github.com/google/fonts/raw/main/ofl/newsreader/Newsreader%5Bopsz,wght%5D.ttf' -o "$tmp/newsreader.ttf"
sub "$tmp/newsreader.ttf" --flavor=woff2 --layout-features='*' --unicodes="$LATIN" --output-file="$out/Newsreader[opsz,wght].woff2"

echo "6. Gulzar (alternative Nastaliq headline face)"
curl -sSL 'https://github.com/google/fonts/raw/main/ofl/gulzar/Gulzar-Regular.ttf' -o "$tmp/gulzar.ttf"
sub "$tmp/gulzar.ttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/Gulzar-Regular.woff2"

rm -rf "$tmp"; ls -la "$out"
