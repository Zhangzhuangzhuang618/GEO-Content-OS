export default {
  plugins: [
    {
      rules: {
        'task-header': ({ header }) => [
          /^(?:\[T\d{3}\]|\[HOTFIX-\d{8}-\d{2}\]) .+$/u.test(header ?? ''),
          'header must match "[Txxx] concise subject" or "[HOTFIX-YYYYMMDD-NN] concise subject" and stay within 100 characters',
        ],
      },
    },
  ],
  rules: {
    'header-max-length': [2, 'always', 100],
    'task-header': [2, 'always'],
  },
};
