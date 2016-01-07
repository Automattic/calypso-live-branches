# Calypso Live Branches

A proxy server which checkouts a branch of your web application and runs it on demand.

## Install
Clone this repository and install the dependencies:
```
git clone https://github.com/Automattic/calypso-live-branches.git
cd calypso-live-branches
npm install
```


## Generic Usage

Run your app with `node lib/index.js <URL_TO_YOUR_REPOSITORY>`.

If your `packages.json` has all the information to build and run your app chances are it might just work. Otherwise you can create a new JSON file whose config will overwrite your `package.json` and run it with:

```
node lib/index.js my-config.json
```

For instance in [Calypso](https://github.com/Automattic/wp-calypso) we use `make build` to build our app and since it itself calls `npm install` we cannot use the default `preinstall` or `postinstall` hooks. So `calypso-live-branches` looks for the special `scripts.build` attribute. See [`calypso.json`](https://github.com/Automattic/calypso-live-branches/blob/master/calypso.json) for an exemple of configuration.

Finally, use the `watchDirs` option if you want to avoid restarting your app on each change.

## Usage for Calypso

Run it with `make run`

## TODO

- [x] Display a page while instance is installing.
- [x] Remove application specific code in `worker.js` (ie `make build` and `require('build/bundle-development.js');`).
- [x] Monitor workers: restart failed workers (or mark them as failing for this commit), shutdown unused workers.
- [x] Create a Dockerfile.
- [ ] Handle erroring branches.
- [ ] Code refactoring and tests.
- [ ] Find alternatives to `require` to launch the server with the patch on `net.Server.listen` (needed so we can proxy it); have a look at [`node-sandboxed-module`](https://github.com/felixge/node-sandboxed-module) or [`pm2`](https://github.com/Unitech/pm2). 
