// Require the framework and instantiate it
const path = require('path')
const fastify = require('fastify')
const fastifyStatic = require('fastify-static');

const io = require('./src/io')
const config = require('./src/config')

const routes = require('./src/routes')

const KEY_FILE = 'server.key'
const CRT_FILE = 'server.crt'
const PUBLIC_FOLDER = 'public'

let serverCfg = undefined;
let mainListener = undefined;
let mainSite = undefined;
let publicRoutes = new Set();
let decorated = new Set();

function addPublicRoute(port, prefix) {
  console.log(`publicRoutes: adding (${port},${prefix})`);
  decorated.add(port);
  publicRoutes.add({ port, prefix });
}
function isPublicRoute(port, prefix) {
  let result = publicRoutes.has({ port, prefix });
  console.log(`publicRoutes: has(${port},${prefix})`,result);
  return result;
}
function needsDecoration(port) {
  return !decorated.has(port);
}

// Returns the SSL or non-SSL related options
async function getListenerOptions(id, sslPath) {
  let options = { logger: false };
  let sslOptions = undefined;

  let keyExists = await io.fileExists(sslPath, KEY_FILE)
  let crtExists = await io.fileExists(sslPath, CRT_FILE)
  if (keyExists && crtExists) {
    let sslkey = await io.fileGet(sslPath, KEY_FILE)
    let sslcrt = await io.fileGet(sslPath, CRT_FILE)

    sslOptions = {
      logger: false,
      http2: true,
      https: {
        allowHTTP1: true, // fallback support for HTTP1
        key: sslkey,
        cert: sslcrt
      }
    }
    console.log(`${id}: Enabled HTTPS via SSL certificate files.`);
    return sslOptions;
  } else {
    console.warn(`${id}: HTTP only. HTTPS disabled. (SSL certificate files NOT provided.)`);
    return options;
  }
}

async function initListener(id, options) {
  // 'listener' is a Fastify instance. 'siteCfg' is the configuration object.
  const listener = fastify(options);
  listener.register(require('fastify-websocket'));
  // Deal with CORS by enabling it since this is an API for all.
  listener.register(require('fastify-cors'), { });
  // fastify.options('*', (request, reply) => { reply.send() })

  listener.setErrorHandler(function (error, request, reply) {
    // Send error response
    console.warn(`${id}: error handler for`,error);
    let code = 500;
    let message = 'Unknown server error';
    if (error.statusCode)
      code = error.statusCode;
    else
    if (error.message)
      message = error.message;
    reply.code(code).send(message);
  })

  return listener;
}

function listenerStart(listener, id, host, port) {
  // Start the server listening.
  console.log(`${id}: Starting listener on port ${port}`)
  listener.listen(port, host, (err) => {
    if (err) {
      console.error(err.message);
      process.exit(1)
    }

    let port = listener.server.address().port;
    console.log(`${id}: listening on port ${port}.`);
  })

  // dump routes at startup?
  if (process.argv.includes('--dump')) {
    console.warn(`Routes for '${id}'on port ${port}:`)
    listener.ready(() => { console.log(listener.printRoutes()) })
  }
}

// Returns the fastify instance on success.
async function serverInit() {
  serverCfg = await config.init();
  if (!serverCfg) {
    console.error("Environment configuration error: ", serverCfg);
    return null;
  }

  // Loop over the listeners and initialize routes.
  await config.forEachSiteAsync (async (site) => {
    let siteCfg = site.getSiteCfg();
    let siteData = site.getSiteData();
    let basePath = site.getSitePath();

    if (siteCfg.port !== 0) {
      let sslPath = path.join(siteData, 'ssl');
      let options = await getListenerOptions(siteCfg.id, sslPath);
      // Save the fastify site listener for easy access.
      siteCfg.listener = await initListener(siteCfg.id, options);
    } else {
      // for this site (port 0), use the main listener
      if (!mainListener) {
        let baseFolder = process.cwd();
        let sslPath = path.join(baseFolder, 'ssl');  
        let options = await getListenerOptions(siteCfg.id, sslPath);
        mainListener = await initListener(siteCfg.id, options);
      }
      siteCfg.listener = mainListener;
    }

    // Initialize the SOSSBox server REST API endpoints.
    if (siteCfg.storage) {
      routes.initRoutes(siteCfg);
    }

    // now support optionally serving static files, e.g. a "public" folder, if specified.
    if (!siteCfg.public) {
      // check if a public folder exists anyway
      if (await io.folderExists(basePath, PUBLIC_FOLDER)) {
        siteCfg.public = PUBLIC_FOLDER;
      }
    }
    if (siteCfg.public) {
      let port = siteCfg.port || 0;
      let prefix = siteCfg.prefix;
      if (!prefix) {
        // if no prefix, mount at /siteId for port 0, otherwise at /
        prefix = (port === 0) ? '/'+siteCfg.id : '/';
      }
      if (isPublicRoute(port, prefix)) {  // (siteCfg.port === 0 && mainSite) {
        console.warn(`${siteCfg.id}: static files cannot be used with port  specified more than once. '${mainSite.id} already defines one.`)
      } else {
        let serveFolder = path.join(basePath, siteCfg.public);
        console.log(`${siteCfg.id}: Serving static files on port ${siteCfg.port} at '${prefix}' from ${serveFolder}`);
        addPublicRoute(port, prefix);
        siteCfg.listener.register(fastifyStatic, {
          root: serveFolder,
          list: true,
          prefix: prefix,
          redirect: true,  // redirect /prefix to /prefix/ to allow file peers to work
          decorateReply: needsDecoration(port) // first one?
        })
        mainSite = siteCfg;
      }
    }

    // If port is 0, just passively use the mainListener.
    if (siteCfg.port !== 0) {
      // Actually start listening on the port now.
      listenerStart(siteCfg.listener, siteCfg.id, siteCfg.host, siteCfg.port);
    }
    return siteCfg.listener;
  });

  // Top-level site?
  let baseFolder = process.cwd();
  let serveFolder = path.join(baseFolder, PUBLIC_FOLDER);
  let sslPath = path.join(baseFolder, 'ssl');  
  let options = await getListenerOptions('main', sslPath);
  let port = serverCfg.port || options.https ? 443 : 80;
  let host = serverCfg.host || '0.0.0.0'; // all NICs

  if (!mainListener) {
    mainListener = await initListener('main', options);
  }
  
  if (await io.folderExists(baseFolder, PUBLIC_FOLDER)) {
    let prefix = '/';
    if (publicRoutes.has({ port: 0, prefix})) { // (mainSite) {
      console.warn(`main: public static files ignored, cannot be used when site '${mainSite.id}' already defines one at ${prefix}.`)
    } else {
      console.log(`${mainSite.id}: Serving static files on port ${mainSite.port} at '${prefix}' from ${serveFolder}`);
      publicRoutes.add({ port: 0, prefix});
      // If port is 0, default to the standard HTTP or HTTPS ports for web servers.
      mainListener.register(fastifyStatic, {
        root: serveFolder,
        list: false,
        prefix
      })
    }
  } else {
    if (!mainSite) {
      console.log(`Serving default site for port [${port}] at '/'.`);
      publicRoutes.add({ port: 0, prefix: '/'});
      mainListener.get('/', (request, reply) => {
        let name = serverCfg.domain || serverCfg.id || 'main'
        reply.send('You have reached the API server for '+name)
      });
    }
  }

  console.log(`main: top-routes are:`);
  publicRoutes.forEach( r => console.log('  '+r.port+': '+r.prefix))

  // Actually start listening on the port now.
  try {
    listenerStart(mainListener, 'main', host, port);
  } catch (err) {
    console.error(err.message)
  }
  return mainListener;
}

// Mainline / top-level async function invocation.
(async () => {
  try {
    await serverInit();  // returns a fastify instance
  } catch (e) {
    console.error(e);
  }
})();