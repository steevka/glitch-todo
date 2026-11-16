'use strict';
// Real #rtx5080 alerts (Falcodrin Server), Nov 4–15 2026, one of each kind.
// `fire` = what the default settings should do with it.
module.exports = [
  {
    fire: false, // third-party seller
    text: `@5080
Name: PNY NVIDIA GeForce RTX™ 5080 Triple-Fan Graphics Card | 16GB GDDR7, 256-bit, Boost Speed: 2617 MHz, PCIe® 5.0, HDMI®/DP 2.1, 2.99-Slot, NVIDIA Blackwell Architecture, DLSS 4.5 (Used - VeryGood)
Condition: Used - Very Good
Merchant: Atomic Cellular
Price: $2390.00
Current Price: $1622.22
Discount: %32.12
Price as of: 11/04/2026 16:10:23
Product Link`,
  },
  {
    fire: false, // base model (Ventus)
    text: `@5080
Name: msi Gaming RTX 5080 16G Ventus 3X OC White Graphics Card (16GB GDDR7, 256-bit, Extreme Clock TBD MHz, DisplayPort x 3 2.1a, HDMI 2.1b, NVIDIA Blackwell Architecture)
Merchant: Amazon.com
Current Price: $1679.99
Quantity: 2
Price as of: 11/04/2026 18:27:13
Product Link`,
  },
  {
    fire: true, // sweet spot, new from Amazon, $1,799.99 <= $1,810 (no Condition line)
    text: `@5080
Name: PNY NVIDIA GeForce RTX™ 5080 Epic-X RGB™ OC Triple-Fan Graphics Card | 16GB GDDR7, 256-bit, Boost Speed: 2775 MHz, PCIe® 5.0, HDMI®/DP 2.1, 2.99-Slot, NVIDIA Blackwell Architecture, DLSS 4.5
Merchant: Amazon.com
Current Price: $1799.99
Price as of: 11/05/2026 07:21:34
Product Link`,
  },
  {
    fire: false, // sweet spot Resale at $1,804.99 > $1,600 used cap
    text: `@5080
Name: ASUS ProArt GeForce RTX 5080 16GB GDDR7 OC Edition Graphics Card | PCIe 5.0, USB Type-C, HDMI/DP 2.1, 2.5-slot, Axial-tech Fans, Vapor Chamber, Phase-change GPU Thermal Pad (Used - LikeNew)
Condition: Used - Like New
Merchant: Amazon Resale
Price: $1804.99
Current Price: $1804.99
Quantity: 1
Price as of: 11/05/2026 13:29:13
Product Link`,
  },
  {
    fire: false, // base model even at a great price
    text: `@5080
Name: ASUS Prime GeForce RTX 5080 16GB GDDR7 OC Edition Gaming Graphics Card | SFF-Ready, PCIe 5.0, HDMI/DP 2.1, 2.5-slot, Axial-tech Fans, Vapor Chamber, Dual BIOS (Used - LikeNew)
Condition: Used - Like New
Merchant: Amazon Resale
Price: $1388.12
Current Price: $1388.12
Quantity: 1
Price as of: 11/06/2026 23:04:38
Product Link`,
  },
  {
    fire: false, // sweet spot but third-party seller
    text: `@5080
Name: msi Gaming RTX 5080 16G Gaming Trio OC Graphics Card (16GB GDDR7, 256-bit, Extreme Performance: 2715 MHz, DisplayPort x 3 2.1a, HDMI 2.1b, NVIDIA Blackwell Architecture)
Merchant: Fast & Precise Electronics (All SN are recorded)
Current Price: $1729.99
Quantity: 1
Price as of: 11/06/2026 21:12:05
Product Link`,
  },
  {
    fire: true, // TUF Resale $1,804.99 <= $1,810 TUF used cap
    text: `@5080
Name: ASUS TUF Gaming GeForce RTX™ 5080 16GB GDDR7 OC Edition Graphics Card | PCIe 5.0, HDMI/DP 2.1, 3.6-slot, Military-grade Components, Protective PCB Coating, Axial-tech Fans (Used - LikeNew)
Condition: Used - Like New
Merchant: Amazon Resale
Price: $1804.99
Current Price: $1804.99
Quantity: 1
Price as of: 11/10/2026 14:54:27
Product Link`,
  },
  {
    fire: true, // flagship (air Suprim SOC), new from Amazon, no Condition line
    text: `@5080
Name: msi Gaming RTX 5080 16G SUPRIM SOC Graphics Card (16GB GDDR7, 256-bit, Extreme Performance: 2760 MHz, DisplayPort x 3 2.1a, HDMI 2.1b, NVIDIA Blackwell Architecture)
Merchant: Amazon.com
Current Price: $1799.99
Quantity: 1
Price as of: 11/10/2026 22:06:57
Product Link`,
  },
  {
    fire: true, // same, first monitor's format with @Amazon and Condition
    text: `@5080
@Amazon
Name: msi Gaming RTX 5080 16G SUPRIM SOC Graphics Card (16GB GDDR7, 256-bit, Extreme Performance: 2760 MHz, DisplayPort x 3 2.1a, HDMI 2.1b, NVIDIA Blackwell Architecture) (New)
Condition: New
Merchant: Amazon.com
Price: $1799.99
Current Price: $1799.99
Price as of: 11/11/2026 07:05:03
Product Link`,
  },
  {
    fire: false, // Suprim Liquid = AIO, excluded
    text: `@5080
@Amazon
Name: msi Gaming RTX 5080 16G SUPRIM Liquid SOC Graphics Card (16GB GDDR7, 256-bit, Extreme Performance: 2760 MHz, DisplayPort x 3 2.1a, HDMI 2.1b, NVIDIA Blackwell Architecture) (Used - Very Good)
Condition: Used - Very Good
Merchant: Amazon Resale
Price: $1535.41
Current Price: $1535.41
Price as of: 11/12/2026 05:59:37
Product Link`,
  },
  {
    fire: false, // Gaming OC new but from a third party
    text: `@5080
@Amazon
Name: Gigabyte GeForce RTX 5080 Gaming OC 16G Graphics Card - 16GB GDDR7, 256bit, PCI-E 5.0, 2730MHz Core Clock, 3 x DisplayPort, 1 x HDMI, GV-N5080GAMING OC-16GD (New)
Condition: New
Merchant: QyTech
Price: $1694.80
Current Price: $1439.99
Price as of: 11/12/2026 15:42:22
Product Link`,
  },
  {
    fire: false, // Renewed, third party
    text: `@5080
@Amazon
Name: PNY NVIDIA GeForce RTX™ 5080 EPIC-X RGB® OC 3-Fan Graphics Card (Renewed) | 16GB GDDR7, 256-bit, Boost: 2775 MHz, PCIe® 5.0, HDMI®/DP 2.1, 2.99-Slot, NVIDIA Blackwell Architecture, DLSS 5 (Refurbished - Excellent)
Condition: Renewed
Merchant: CorteseInc26
Price: $2399.00
Current Price: $1389.00
Price as of: 11/13/2026 16:16:13
Product Link`,
  },
  {
    fire: false, // Gaming OC Resale $1,804.99 > $1,600 used cap
    text: `@5080
@Amazon
Name: GIGABYTE GeForce RTX 5080 Gaming OC 16G Graphics Card, WINDFORCE Cooling System, 16GB 256-bit GDDR7, GV-N5080GAMING OC-16GD Video Card (Used - Like New)
Condition: Used - Like New
Merchant: Amazon Resale
Price: $1804.99
Current Price: $1804.99
Price as of: 11/14/2026 07:32:59
Product Link`,
  },
  {
    fire: false, // ProArt Resale $1,730.59 > $1,600 used cap
    text: `@5080
@Amazon
Name: ASUS ProArt GeForce RTX 5080 16GB GDDR7 OC Edition Graphics Card | PCIe 5.0, USB Type-C, HDMI/DP 2.1, 2.5-slot, Axial-tech Fans, Vapor Chamber, Phase-change GPU Thermal Pad (Used - Like New)
Condition: Used - Like New
Merchant: Amazon Resale
Price: $1730.59
Current Price: $1730.59
Price as of: 11/14/2026 09:18:54
Product Link`,
  },
  {
    fire: false, // base (Zotac Solid)
    text: `@5080
@Amazon
Name: ZOTAC Gaming GeForce RTX 5080 Solid CORE OC DLSS 4 16GB GDDR7 256-bit 30 Gbps PCIE 5.0 Gaming Graphics Card, IceStorm 3.0 Advanced Cooling, Spectra RGB Lighting, ZT-B50800J2-10A (Used - VeryGood)
Condition: Used - Very Good
Merchant: Amazon Resale
Price: $1597.99
Current Price: $1597.99
Quantity: 1
Price as of: 11/15/2026 10:58:40
Product Link`,
  },
  {
    fire: false, // MSI store drop, no Amazon link
    links: ['https://us-store.msi.com/GeForce-RTX-5080-16G-SUPRIM-DRACO-EPIC-EDITION?search=5080&limit=100'],
    text: `@5080
Drop Detected
Store: MSI
Product Category: 5080
All products link: https://us-store.msi.com/search?search=5080&limit=100

Individual product(s):
GeForce RTX 5080 16G SUPRIM DRACO EPIC EDITION ($1,799.99): https://us-store.msi.com/GeForce-RTX-5080-16G-SUPRIM-DRACO-EPIC-EDITION?search=5080&limit=100`,
  },
];
