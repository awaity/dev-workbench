export default {
  extends: ['stylelint-config-standard-scss'],
  customSyntax: 'postcss-scss',
  overrides: [{ files: ['**/*.vue'], customSyntax: 'postcss-html' }],
  ignoreFiles: ['dist/**/*', '.output/**/*', 'node_modules/**/*'],
  rules: {
    'rule-empty-line-before': null,
    'scss/dollar-variable-empty-line-after': null,
    'scss/dollar-variable-empty-line-before': null,
    'scss/double-slash-comment-empty-line-before': null,
    'color-function-notation': null,
    'color-function-alias-notation': null,
    'alpha-value-notation': null,
    'selector-class-pattern': null,
    'selector-pseudo-class-no-unknown': [
      true,
      { ignorePseudoClasses: ['global', 'deep', 'slotted'] },
    ],
    'scss/at-rule-no-unknown': true,
  },
};
