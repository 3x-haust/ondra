"""Execute admission guards without executing the preparation script."""
import ast
import copy
from pathlib import Path
import unittest

SOURCE = Path(__file__).with_name('restart-preparation.py')


class RestartGuards(unittest.TestCase):
    def test_runner_identity_refused_at_every_optimization_level(self):
        tree = ast.parse(SOURCE.read_text())
        guard = next(node for node in tree.body
                     if isinstance(node, (ast.Assert, ast.Expr))
                     and 'actual_command' in ast.unparse(node))
        helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'require']
        for optimized in (0, 1, 2):
            for matches in (True, False):
                with self.subTest(optimized=optimized, matches=matches):
                    code = compile(ast.Module(body=copy.deepcopy(helpers + [guard]), type_ignores=[]),
                                   '<admission-guard>', 'exec', optimize=optimized)
                    scope = {'actual_command': 'owned' if matches else 'unrelated', 'expected_command': 'owned'}
                    if matches:
                        exec(code, scope)
                    else:
                        with self.assertRaises((AssertionError, RuntimeError)):
                            exec(code, scope)

    def test_no_optimizable_safety_assertions(self):
        tree = ast.parse(SOURCE.read_text())
        self.assertEqual([node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)], [])


if __name__ == '__main__':
    unittest.main()
