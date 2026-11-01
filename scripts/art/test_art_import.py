"""Проверки прозрачности: python -m unittest discover -s scripts/art -p 'test_*.py'."""

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from art_import import process


class TransparencyTests(unittest.TestCase):
    def import_image(self, image):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            mask = np.zeros((128, 128, 4), np.uint8)
            mask[16:112, 16:112] = 255
            cv2.imwrite(str(d / 'mask.png'), mask)
            cv2.imwrite(str(d / 'guide.png'), np.full((128, 128, 3), 255, np.uint8))
            cv2.imwrite(str(d / 'source.png'), image)
            result = process(
                d / 'source.png', d / 'guide.png', d / 'mask.png',
                {'size': [128, 128], 'origin': [64, 64], 'ppm': 1},
                d / 'result.webp', d / 'check.jpg', align=False,
            )
            out = cv2.imread(str(d / 'result.webp'), cv2.IMREAD_UNCHANGED)
            x, y = map(round, result['origin'])
            return out, x, y

    def test_transparent_courtyard_inside_model_stays_open(self):
        image = np.zeros((128, 128, 4), np.uint8)
        image[16:112, 16:112] = [220, 220, 220, 255]
        image[48:80, 48:80, 3] = 0
        image[30:40, 30:40, 3] = 180
        out, x, y = self.import_image(image)
        self.assertEqual(out[y, x, 3], 0)
        self.assertEqual(out[y - 29, x - 29, 3], 180)
        self.assertEqual(out[y + 30, x + 30, 3], 255)
        self.assertEqual(out[0, 0, 3], 0)

    def test_white_facade_is_preserved_on_opaque_source(self):
        image = np.full((128, 128, 4), 255, np.uint8)
        image[16:112, 16:112, :3] = 250
        out, x, y = self.import_image(image)
        self.assertEqual(out[y, x, 3], 255)
        self.assertEqual(out[0, 0, 3], 0)

    def test_connected_spire_outside_mask_is_preserved(self):
        image = np.zeros((128, 128, 4), np.uint8)
        image[16:112, 16:112] = [220, 220, 220, 255]
        image[4:24, 56:72] = [220, 220, 220, 255]
        image[4:10, 4:10] = [220, 220, 220, 255]
        out, x, y = self.import_image(image)
        self.assertEqual(out[y - 56, x, 3], 255)
        self.assertEqual(out[0, 0, 3], 0)


if __name__ == '__main__':
    unittest.main()
