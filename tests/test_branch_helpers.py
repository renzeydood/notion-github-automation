import importlib.util
import pathlib
import unittest
from unittest.mock import patch

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('create', root / 'scripts/create_notion_branch.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BranchTests(unittest.TestCase):
    def test_slug(self):
        self.assertEqual(module.slug('Add CSV Export!'), 'add_csv_export')

    def test_duplicate_across_phase_and_title(self):
        with patch.object(module, 'github', return_value=[
            {'name': 'feature/MAP-42_original_title'},
            {'name': 'bug/MAP-43_another'},
            {'name': 'feature/MAP-420_other'},
        ]):
            self.assertEqual(module.find_ticket_branches('example/example-project', 'MAP-42'), ['feature/MAP-42_original_title'])

if __name__ == '__main__':
    unittest.main()
