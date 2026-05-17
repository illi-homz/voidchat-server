import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';

export default [
	eslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				console: 'readonly',
				setInterval: 'readonly',
				process: 'readonly',
			},
		},
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsparser,
		},
		plugins: {
			'@typescript-eslint': tseslint,
			prettier: prettier,
		},
		rules: {
			semi: ['error', 'always'],
			indent: ['error', 'tab', { SwitchCase: 1 }],
			'no-mixed-spaces-and-tabs': ['error'],
			'object-curly-spacing': ['error', 'always'],
			quotes: ['error', 'single', { avoidEscape: true }],
			curly: ['error', 'multi-line'],
			'no-trailing-spaces': ['error', { skipBlankLines: true }],
			'prettier/prettier': ['error', { endOfLine: 'auto' }],
			'max-len': ['error', { code: 120 }],
			'@typescript-eslint/no-unused-vars': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'no-trailing-spaces': 'error',
		},
	},
	{
		plugins: {
			prettier: prettier,
		},
		rules: {
			'prettier/prettier': ['error', {}, { usePrettierrc: true }],
		},
	},
];
