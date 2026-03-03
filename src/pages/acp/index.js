function AcpPage() {
	import(/* webpackChunkName: "acp" */ "./acp").then((res) => {
		res.default();
	});
}
export default AcpPage;
