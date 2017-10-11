whoami=$(shell whoami)
pwd=$(shell pwd)

run:
	TMP_DIR=/tmp/data DEBUG=clb-server,clb-worker,clb-repo node lib/index.js calypso.json

run-prod:
	TMP_DIR=/home/ubuntu/data DEBUG=clb-server,clb-worker,clb-repo pm2 start --name=calypso ./lib/index.js -- ./calypso.json

docker-build:
	docker build -t clb .

docker-run: docker-build
	mkdir -p ./tmp
	-docker rm clb-test
	docker run -it --name clb-test -v $(pwd)/tmp:/data -p 3000:3000 clb

docker-run-daemon: docker-build
	mkdir -p ./tmp
	-docker stop clb-test
	-docker rm clb-test
	docker run -d --name clb-test -v $(pwd)/tmp:/data -p 3000:3000 clb

docker-flush:
	-docker stop $(shell docker ps -a -q)
	-docker rm $(shell docker ps -a -q)

docker-flush-all: docker-flush
	-docker rmi $(shell docker images -a -q)
