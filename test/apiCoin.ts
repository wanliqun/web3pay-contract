import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {Airdrop, APICoin, ApiV2, APPCoin, AppV2, Controller, UpgradeableBeacon} from "../typechain";
import { ContractReceipt } from "ethers";
import {SignerWithAddress} from "@nomiclabs/hardhat-ethers/signers";
import assert from "assert";
const {
  utils: { formatEther, parseEther },
} = ethers;
enum OP {ADD,UPDATE,DELETE}
async function attach(name:string, to:string) {
  const template = await ethers.getContractFactory(name);
  return template.attach(to)
}
async function deploy(name:string,args: any[]) {
  const template = await ethers.getContractFactory(name);
  const deploy = await template.deploy(...args)
  const instance = await deploy.deployed();
  console.log(`deploy ${name} at ${instance.address}, tx ${deploy.deployTransaction.hash}`)
  return instance;
}
async function deployApp(name: string, args: any[]) {
  const app = await deploy(name, []).then(res=>res as APPCoin)
  const [apiCoin,appOwner,name_,symbol] = args;
  await app.init(apiCoin,appOwner,name_,symbol)
  return app;
}
async function deployProxy(name: string, args: any[]) {
  const template = await ethers.getContractFactory(name);
  const proxy = await upgrades.deployProxy(template, args);
  const contract = await proxy.deployed();
  console.log(`deploy proxy ${name}, got ${contract.address}`);
  return contract;
}
function dumpEvent(receipt: ContractReceipt) {
  console.log(
    receipt.events?.map((e) => `${e.address} ${e.event}, ${e.args}`).join("\n")
  );
  return receipt;
}
async function deployAndDeposit(appOwner:SignerWithAddress, appTemplate="APPCoin") {
  const ownerAddr = await appOwner.getAddress();
  const api = (await deployProxy("APICoin", ["main coin", "mc", []])) as APICoin;
  const appWithOwnerSet = (await deployApp(appTemplate, [
    api.address,
    ownerAddr, // set app owner
    "APP 1",
    "APP1",
  ])).connect(appOwner) as APPCoin;
  await api
      .depositToApp(appWithOwnerSet.address, { value: parseEther("1") })
      .then((res) => res.wait());
  const appWithDefaultOwner = await appWithOwnerSet.connect(api.signer);
  return {api, app:appWithOwnerSet, app2:appWithDefaultOwner}
}
describe("Controller", async function () {
  const signerArr = await ethers.getSigners();
  const [signer1, signer2, signer3] = signerArr;
  const [acc1, acc2] = await Promise.all(signerArr.map((s) => s.getAddress()));
  it("createApp" , async function (){
    const api = await deployProxy("APICoin", ["main coin", "mc", []]) as APICoin
    const controller = await deploy("Controller", [api.address]).then(res=>res as Controller);

    const tx = await controller.createApp("CoinA", "CA").then(res=>res.wait())
    expect(tx).emit(controller, controller.interface.events["APP_CREATED(address,address)"].name);
    // @ts-ignore
    const createdAppAddr = tx.events?.filter(e=>e.event === controller.interface.events["APP_CREATED(address,address)"].name)
        [0].args[0]
    //
    const app = await attach("APPCoin", createdAppAddr).then(res=>res as APPCoin)
    console.log(`app business owner`, await app.appOwner())
    console.log(`app contract owner`, await app.owner())

    console.log(`api contract owner`, await api.owner())
    expect(await app.appOwner()).eq(acc1)
    expect(await app.owner()).eq(acc1)
    expect(await api.owner()).eq(acc1)
    expect(await app.name()).eq("CoinA")
    expect(await app.symbol()).eq("CA")
    // list created app
    controller.createApp("CoinB", "CB").then(res=>res.wait())
    const [createdAppArr, total] = await controller.listAppByCreator(acc1, 0, 10)
    expect(createdAppArr.length).eq(2)
    expect(total).eq(2)
    expect(createdAppArr[0].addr).eq(createdAppAddr)
  })
  it("list created app", async function (){
    const controller = await deploy("Controller", [ethers.constants.AddressZero]).then(res=>res as Controller);
    await controller.createApp("app 1", "a1").then(tx=>tx.wait());
    await controller.createApp("app 2", "a2").then(tx=>tx.wait());
    const [arr, total] = await controller.listApp(0, 10);
    expect(arr.length).eq(2)
    expect(total).eq(2)
  })
  it("upgrade api contract, UUPS", async function (){
    const api = await deployProxy("APICoin", ["main coin", "mc", []]) as APICoin
    const controller = await deploy("Controller", [api.address]).then(res=>res as Controller);
    await controller.createApp("app 1", "a1").then(tx=>tx.wait());
    const api1addr = api.address
    const app1 = await controller.appMapping(0)
    const originApp1 = await attach("APICoin", api1addr) as APICoin
    await originApp1.depositToApp(app1, {value: parseEther("1")}).then(tx=>tx.wait())
    //
    const apiv2 = await deploy("ApiV2",[]) as ApiV2;
    await expect(originApp1.upgradeTo(apiv2.address)).emit(originApp1, originApp1.interface.events["Upgraded(address)"].name)
        .withArgs(apiv2.address);
    const upgradedV2 = await apiv2.attach(api1addr)
    expect(await upgradedV2.version()).eq("ApiV2")
    expect(await originApp1.balanceOf(app1)).eq(parseEther("1"))
  })

  it("upgrade app, beacon", async function (){
    const controller = await deploy("Controller", [ethers.constants.AddressZero]).then(res=>res as Controller);
    await controller.createApp("app 1", "a1").then(tx=>tx.wait());

    const app1addr = await controller.appMapping(0);
    const originApp1 = await attach("APPCoin", app1addr) as APPCoin
    await originApp1.configResource({id:0, resourceId:"path0", weight:10, op: OP.ADD}).then(tx=>tx.wait())

    const appUpgradeableBeacon = await controller.appBase().then(addr=>attach("UpgradeableBeacon", addr))
        .then(c=>c as UpgradeableBeacon);
    // check owner
    expect(await appUpgradeableBeacon.owner()).eq(acc1);

    const v2 = await deploy("AppV2", []).then(res=>res as AppV2);
    await expect(appUpgradeableBeacon.upgradeTo(v2.address))
        .emit(appUpgradeableBeacon, appUpgradeableBeacon.interface.events["Upgraded(address)"].name)
        .withArgs(v2.address)
    // call new method
    const appV2 = await v2.attach(app1addr)
    expect(await appV2.version()).eq("App v2");
    expect(await originApp1.resourceConfigures(2).then(info=>info.weight)).eq(10)
  })
})
describe("ApiCoin", async function () {
  const signerArr = await ethers.getSigners();
  const [signer1, signer2, signer3] = signerArr;
  const [acc1, acc2, acc3] = await Promise.all(signerArr.map((s) => s.getAddress()));
  it("Should deposit to app", async function () {
    const api = (await deployProxy("APICoin", ["main coin", "mc", []])) as APICoin;
    const app = (await deployApp("APPCoin", [
      api.address,
      acc1,
      "APP 1",
      "APP1",
    ])) as APPCoin;

    expect(await app.apiCoin()).to.equal(api.address);
    //
    const spend = parseEther("1.23");
    const account = await api.signer.getAddress();
    expect(
      await api
        .depositToApp(app.address, { value: spend })
        .then((res) => res.wait())
        .then(dumpEvent)
    )
      .emit(app, app.interface.events["Transfer(address,address,uint256)"].name)
      .withArgs(ethers.constants.AddressZero, account, spend);
    await app.balanceOf(account).then((res) => {
      console.log(`balance of app, user ${account}`, formatEther(res));
    });
    //
  });
  it("config resource weights", async function () {
    const api = (await deployProxy("APICoin", ["main coin", "mc", []])) as APICoin;
    const app = (await deployApp("APPCoin", [
      api.address,
      acc1,
      "APP 1",
      "APP1",
    ])) as APPCoin;
    // default resource weight 1, id 1, index 0
    let defaultConfig = await app.resourceConfigures(1);
    assert(defaultConfig.weight == 1,'default weight should be 1')
    assert(defaultConfig.resourceId == 'default','default resourceId should be <default>')
    assert(defaultConfig.index == 0,'default resource index should be 0')
    // add new one, auto id 2, index 1
    await app
      .configResource({id: 0, resourceId: "path2", weight: 2, op: OP.ADD})
      .then((res) => res.wait())
      .then(dumpEvent)
    let config2 = await app.resourceConfigures(2)
    expect(config2.index == 1, 'index should be 1 for config 2');

    assert(await app.nextConfigId() == 3, 'next id should be 3')

    // update
    await app.configResource({id: 2, resourceId: "path2", weight:200, op: OP.UPDATE})
        .then(tx=>tx.wait())
    config2 = await app.resourceConfigures(2)
    assert(config2.weight == 200, 'weight should be updated')
    assert(config2.index == 1, 'index should be 1')

    // id mismatch resource id
    await expect(
      app.configResource({id: 1, resourceId: "pathN", weight: 3, op: OP.UPDATE})
    ).to.be.revertedWith(`id/resourceId mismatch`);
    // duplicate adding
    await expect(
        app.configResource({id: 0, resourceId: "path2", weight: 3, op: OP.ADD})
    ).to.be.revertedWith(`resource already added`);
    // batch
    await app
      .configResourceBatch([
        {id: 0, resourceId: 'p3', weight: 103, op: OP.ADD}, //add p3, id 3, index 2
        {id: 0, resourceId: 'p4', weight: 104, op: OP.ADD}, //add p4, id 4, index 3
        {id: 0, resourceId: 'p5', weight: 105, op: OP.ADD}, //add p5, id 5, index 4

        {id: 4, resourceId: 'p4', weight: 204, op: OP.UPDATE}, //update p4, id 4, index 3
        {id: 3, resourceId: 'p3', weight: 204, op: OP.DELETE}, //delete p3, id 3, index 2 -- delete
      ]) // index array [1, 2, 3, 4, 5] delete id 3 index 2 => [1, 2, 5, 4]
      .then((res) => res.wait());
    assert(await app.nextConfigId() == 6, 'next id should be 6');
    //
    const [list,total] = await app.listResources(0, 30);
    assert(list.length == 4, 'should have 4 items');
    const [,,[path, w, index]] = list;
    assert(path == 'p5', 'resource id should be right')
    assert(w == 105, 'weight should be right')
    assert(index == 2, `index should be right, ${index} vs 3 `)
  });
  it("check permission", async function () {
    const api = (await deployProxy("APICoin", ["main coin", "mc", []])) as APICoin;
    const app = (await deployApp("APPCoin", [
      api.address,
      acc1,
      "APP 1",
      "APP1",
    ])) as APPCoin;
    await api
      .depositToApp(app.address, { value: parseEther("1") })
      .then((res) => res.wait());
    //
    const app2 = await app.connect(signer2);
    const app3 = await app.connect(signer3);
    console.log(`app contract owner   ${await app.owner()}`);
    console.log(`app business owner   ${await app.appOwner()}`);
    console.log(`app  signer          ${await app.signer.getAddress()}`);
    console.log(`app2 signer          ${await app2.signer.getAddress()}`);
    await expect(
      app3.freeze(api.address, true).then((res) => res.wait())
    ).to.be.revertedWith(`Unauthorised`);
    //
    await expect(
      app2.transfer(api.address, parseEther("1")).then((res) => res.wait())
    ).to.be.revertedWith(`Not permitted`);

    await expect(
      app2
        .send(api.address, parseEther("1"), Buffer.from(""))
        .then((res) => res.wait())
    ).to.be.revertedWith(`Not permitted`);

    await expect(
      app2.burn(parseEther("1"), Buffer.from("")).then((res) => res.wait())
    ).to.be.revertedWith(`Not permitted`);

    await expect(app2.configResource({id:0, resourceId:"p0", weight:10, op:OP.ADD})).to.be.revertedWith(
      `not app owner`
    );
    // app2
    //   .transfer(api.address, parseEther("2"))
    //   .then((res) => res.wait())
    //   .catch((err) => {
    //     console.log(`transfer fail:`, err);
    //   });
  });
  it("withdraw", async function () {
    const {api, app, app2} = await deployAndDeposit(signer1);
    // freeze acc1 by admin
    await app.freeze(acc1, true).then((res) => res.wait());
    await expect(
      app.forceWithdraw().then((res) => res.wait())
    ).to.be.revertedWith(`Frozen by admin`);
    await expect(
      app.withdrawRequest().then((res) => res.wait())
    ).to.be.revertedWith(`Account is frozen`);
    // unfreeze
    await app.freeze(acc1, false).then((res) => res.wait());
    await expect(
      app.forceWithdraw().then((res) => res.wait())
    ).to.be.revertedWith(`Withdraw request first`);
    expect(await app.withdrawRequest().then((res) => res.wait()))
      .to.be.emit(app, app.interface.events["Frozen(address)"].name)
      .withArgs(acc1);
    await expect(
      app.forceWithdraw().then((res) => res.wait())
    ).to.be.revertedWith(`Waiting time`);

    // should transfer api coin from App to acc1
    await app.setForceWithdrawDelay(0).then((res) => res.wait());
    expect(await app.forceWithdraw().then((res) => res.wait()))
      .emit(api, api.interface.events["Transfer(address,address,uint256)"].name)
      .withArgs(app.address, acc1, parseEther("1"));
    expect(await app.balanceOf(acc1)).eq(0);

  });
  it("track charged users", async () => {
    const {api, app:appOwnerAcc2, app2:appSigner1} = await deployAndDeposit(signer2);
    await Promise.all([signer2, signer3].map(s=>{
      return api.connect(s).depositToApp(appOwnerAcc2.address, {value: parseEther("1")}).then(tx=>tx.wait())
    }))
    await appOwnerAcc2.charge(acc1, 1, Buffer.from("")).then(tx=>tx.wait())
    await Promise.all([acc1, acc2, acc3].map(acc=>appOwnerAcc2.charge(acc, 1, Buffer.from("")).then(tx=>tx.wait())))
    await Promise.all([acc1, acc2, acc3].map(acc=>appOwnerAcc2.charge(acc, 1, Buffer.from("")).then(tx=>tx.wait())))
    const [users, total] = await appOwnerAcc2.listUser(0, 10);
    assert(total.eq(3), 'should be 3 users')
    assert(users[0][0] == acc1, `user 0 should be ${acc1}, actual ${users[0][0]}`)
    assert(users[0][1].eq(3), `user 0 should have spent 3 actual ${formatEther(users[0][1])}`)
    assert(users[1][1].eq(2), `user 1 should have spent 2 actual ${(users[0][1])}`)
    assert(users[2][1].eq(2), `user 2 should have spent 2 actual ${(users[0][1])}`)
    assert(users[1][0] == acc2 || users[1][0] == acc3, 'user 1 should be acc2 or acc3')
    assert(users[2][0] == acc2 || users[2][0] == acc3, 'user 2 should be acc2 or acc3')
    assert(users[1][0] !== users[2][0], 'user 1 should not be user 2')
  });
  it("charge and auto refund", async () => {
    const {api, app, app2} = await deployAndDeposit(signer1);
    // charge without refund
    await expect(app.charge(acc1, parseEther("0.1"), Buffer.from("扣费")))
        .to.be.emit(app, app.interface.events["Transfer(address,address,uint256)"].name)
        .withArgs(acc1, ethers.constants.AddressZero, parseEther("0.1"))
    await expect(app.withdrawRequest()).emit(app, app.interface.events["Frozen(address)"].name)
        .withArgs(acc1)
    await expect(app.charge(acc1, parseEther("0.1"), Buffer.from("扣费")))
        .to.be.emit(app, app.interface.events["Transfer(address,address,uint256)"].name)
        .withArgs(acc1, ethers.constants.AddressZero, parseEther("0.8"))// burn
        .emit(api, api.interface.events["Transfer(address,address,uint256)"].name)
        .withArgs(app.address, acc1, parseEther("0.8")) // refund api code
    expect(1).eq(1);
  });
  it("airdrop", async () => {
    const {api, app, app2} = await deployAndDeposit(signer2, "Airdrop");
    const badApp2 = app2 as any as Airdrop
    await expect(badApp2.airdrop(acc1, parseEther('1'), "fail")).to.be.revertedWith(`not app owner`)
    const airdrop = app as any as Airdrop
    const receipt = await airdrop.airdropBatch([acc1], [parseEther("10")], ['test']).then(tx=>tx.wait());
    expect(receipt).emit(airdrop, airdrop.interface.events["Drop(address,uint256,string)"].name)
        .withArgs(acc1, parseEther("10"), 'test')
    let [total, drop] = await airdrop.balanceOfWithAirdrop(acc1)
    assert( total.eq(parseEther("11")), `should be 11 app coin, ${total}`)
    assert( drop.eq(parseEther("10")), `should be 10 airdrop, ${drop}`)
    await expect(app.charge(acc1, parseEther("1"), Buffer.from("sub 1 left 1 + 9")))
        .emit(airdrop, airdrop.interface.events["Spend(address,uint256)"].name).withArgs(acc1, parseEther("1"))
        .emit(airdrop, airdrop.interface.events["Transfer(address,address,uint256)"].name)
        .withArgs(acc1, ethers.constants.AddressZero, parseEther("0"));
    [total, drop] = await airdrop.balanceOfWithAirdrop(acc1)
    assert( total.eq(parseEther("10")), `should be 10 app coin, ${total}`)
    assert( drop.eq(parseEther("9")), `should be 9 airdrop, ${drop}`)
    assert(parseEther("1").eq(await airdrop.balanceOf(acc1)), "should be 1 origin app coin")

    await expect(app.charge(acc1, parseEther("9.5"), Buffer.from("sub 9.5 left 0.5 + 0")))
        .emit(airdrop, airdrop.interface.events["Spend(address,uint256)"].name).withArgs(acc1, parseEther("9"))
        .emit(airdrop, airdrop.interface.events["Transfer(address,address,uint256)"].name)
        .withArgs(acc1, ethers.constants.AddressZero, parseEther("0.5"));

    [total, drop] = await airdrop.balanceOfWithAirdrop(acc1)
    assert( total.eq(parseEther("0.5")), `should be 0.5 app coin, ${total}`)
    assert( drop.eq(parseEther("0")), `should be 0 airdrop, ${drop}`)
  });
  it("track paid app", async () => {
    const {api, app, app2} = await deployAndDeposit(signer1);
    let [list,total] = await api.listPaidApp(acc1, 0, 10);
    assert(total.toNumber() == 1, "should have 1 paid app")
    assert(list[0] === app.address, "should be the right app")
    // create new app
    const appNew2 = await deployApp("APPCoin", [
      api.address,
      acc2, // set acc2 as app owner
      "APP 2",
      "APP2",
    ])
    await api
        .depositToApp(appNew2.address, { value: parseEther("1") })
        .then((res) => res.wait());

    [list,total] = await api.listPaidApp(acc1, 0, 10);
    assert(total.toNumber() == 2, "should have 2 paid app")
    assert(list[1] === appNew2.address, "should be the right app")

    // deposit to app1 again
    await api
        .depositToApp(app.address, { value: parseEther("1") })
        .then((res) => res.wait());

    [list,total] = await api.listPaidApp(acc1, 0, 10);
    assert(total.toNumber() == 2, "should have 2 paid app")
    assert(list[0] === app.address, "should be the right app")
  });
});
