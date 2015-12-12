run:
	-mkdir -p ./data/sockets
	-rm -rf ./data/sockets/*
	NODE_ENV=development CALYPSO_ENV=development NODE_PATH=server:shared:. PROJECT=https://github.com/Automattic/wp-calypso.git DIR=data node index.js
