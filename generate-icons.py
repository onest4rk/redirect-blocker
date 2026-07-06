#!/usr/bin/env python3
"""
Generate simple PNG icons for the Redirect Blocker extension.
Creates a red circle with a white X symbol.
"""

import struct
import zlib
import os

def create_png(width, height, filename):
    """Create a simple PNG with a red circle and white X."""

    # Create pixel data (RGB)
    pixels = []
    center_x, center_y = width / 2, height / 2
    radius = min(width, height) / 2 - 1

    for y in range(height):
        row = []
        for x in range(width):
            # Check if pixel is inside the circle
            dx = x - center_x
            dy = y - center_y
            distance = (dx * dx + dy * dy) ** 0.5

            if distance <= radius:
                # Inside circle - check if it's part of the X
                # X is drawn as two diagonal lines
                in_x = False
                # First diagonal: top-left to bottom-right
                if abs(dx - dy) < max(1, width * 0.12):
                    in_x = True
                # Second diagonal: top-right to bottom-left
                if abs(dx + dy) < max(1, width * 0.12):
                    in_x = True

                if in_x:
                    row.extend([255, 255, 255])  # White X
                else:
                    row.extend([229, 57, 53])  # Red circle (#e53935)
            else:
                row.extend([0, 0, 0])  # Black background

        pixels.append(bytes([0] + row))  # Filter byte + RGB data

    # Combine all rows
    raw_data = b''.join(pixels)

    # Create PNG file
    def create_chunk(chunk_type, data):
        chunk = chunk_type + data
        crc = zlib.crc32(chunk) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc)

    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = create_chunk(b'IHDR', ihdr_data)

    # IDAT chunk (compressed pixel data)
    compressed = zlib.compress(raw_data)
    idat = create_chunk(b'IDAT', compressed)

    # IEND chunk
    iend = create_chunk(b'IEND', b'')

    # Write PNG file
    with open(filename, 'wb') as f:
        f.write(signature)
        f.write(ihdr)
        f.write(idat)
        f.write(iend)

    print(f"Created {filename} ({width}x{height})")

# Generate icons for required sizes
sizes = [16, 32, 48, 128]
icons_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')

# Create icons directory if it doesn't exist
os.makedirs(icons_dir, exist_ok=True)

for size in sizes:
    filename = os.path.join(icons_dir, f'icon{size}.png')
    create_png(size, size, filename)

print("\nAll icons generated successfully!")
print("Note: These are simple generated icons. For production, consider using")
print("a proper design tool to create more polished icons.")
