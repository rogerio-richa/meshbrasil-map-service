const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const nodeExternals = require('webpack-node-externals');

const {
    NODE_ENV = 'development',
  } = process.env;

module.exports = {
  entry: './src/index.ts',
  target: 'node',
  mode: NODE_ENV,
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'index.js',
    path: path.resolve(__dirname, 'js'),
  },
  externals: [ nodeExternals() ],
  plugins: [
    new CleanWebpackPlugin(),
  ],
};
