"""Проверки прозрачности: python -m unittest discover -s scripts/art -p 'test_*.py'."""

import tempfile
import json
import unittest
from unittest.mock import patch
from pathlib import Path

import cv2
import numpy as np

from art_import import find_warp, process
from art import validate_source_frame


class SourceFrameTests(unittest.TestCase):
    def test_missing_or_old_frame_cannot_be_imported_as_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'building.png'
            frame = {'geometry': 'same', 'camera': {'lean': 0}, 'size': [1024, 1536]}
            with self.assertRaisesRegex(SystemExit, 'нет building.frame.json'):
                validate_source_frame(src, frame)
            sidecar = src.with_suffix('.frame.json')
            sidecar.write_text(json.dumps({**frame, 'camera': {'lean': .24}}))
            with self.assertRaisesRegex(SystemExit, 'другому каркасу'):
                validate_source_frame(src, frame)
            sidecar.write_text(json.dumps(frame))
            validate_source_frame(src, frame)


class AlignmentTests(unittest.TestCase):
    def test_alignment_does_not_tilt_verticals(self):
        guide = np.full((128, 128, 3), 255, np.uint8)
        art = np.full((128, 128, 4), 255, np.uint8)
        mask = np.ones((128, 128), bool)
        tilted = np.array([[1.02, 0.04, 2], [-0.03, 0.98, 3]], np.float32)
        with patch('art_import.ecc', side_effect=lambda *args: tilted.copy()):
            warp = find_warp(guide, mask, art, False)
        self.assertIsNotNone(warp)
        inverse = cv2.invertAffineTransform(warp)
        points = np.array([[40, 10, 1], [40, 110, 1]], np.float32)
        projected = points @ inverse.T
        self.assertAlmostEqual(projected[0, 0], projected[1, 0], places=6)
        center = np.array([64, 64, 1], np.float32)
        np.testing.assert_allclose(warp @ center, tilted @ center, atol=1e-5)


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
