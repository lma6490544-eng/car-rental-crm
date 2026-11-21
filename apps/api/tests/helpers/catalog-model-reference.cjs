// Independent frozen pre-stage-24 classes; application code never imports this module.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/catalog-model-before-stage24.json');
function load(text, name) {
  const filename = path.resolve(__dirname, '../../dist/catalog/reference-' + name + '.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(
    ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
  return loaded.exports;
}
module.exports = {
  VehiclesController: load(source.controllerSource, 'vehicles').VehiclesController,
  CatalogService: load(source.serviceSource, 'catalog').CatalogService,
};
