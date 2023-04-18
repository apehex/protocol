import fs from 'fs'
import hre from 'hardhat'
import { getChainId } from '../../../../common/blockchain-utils'
import { networkConfig } from '../../../../common/configuration'
import { bn, fp } from '../../../../common/numbers'
import { expect } from 'chai'
import { CollateralStatus } from '../../../../common/constants'
import { getDeploymentFile, getAssetCollDeploymentFilename, IAssetCollDeployments, getDeploymentFilename, fileExists } from '../../common'
import { priceTimeout, oracleTimeout } from '../../utils'
import { MaplePoolFiatCollateral } from '../../../../typechain'
import { ContractFactory } from 'ethers'

async function main() {
    // ==== Read Configuration ====
    const [deployer] = await hre.ethers.getSigners()

    const chainId = await getChainId(hre)

    console.log(`Deploying Collateral to network ${hre.network.name} (${chainId})
        with burner account: ${deployer.address}`)

    if (!networkConfig[chainId]) {
        throw new Error(`Missing network configuration for ${hre.network.name}`)
    }

    // Get phase1 deployment
    const phase1File = getDeploymentFilename(chainId)
    if (!fileExists(phase1File)) {
        throw new Error(`${phase1File} doesn't exist yet. Run phase 1`)
    }
    // Check previous step completed
    const assetCollDeploymentFilename = getAssetCollDeploymentFilename(chainId)
    const assetCollDeployments = <IAssetCollDeployments>getDeploymentFile(assetCollDeploymentFilename)

    const deployedCollateral: string[] = []

    /********  Deploy Maple Permissionless USDC Pool Collateral (MPL-mcUSDC2)  **************************/

    const MaplePoolFiatCollateralFactory: ContractFactory = await hre.ethers.getContractFactory(
        'MaplePoolFiatCollateral'
    )

    const collateral = <MaplePoolFiatCollateral>await MaplePoolFiatCollateralFactory.connect(
        deployer
    ).deploy(
        {
            priceTimeout: priceTimeout.toString(),
            chainlinkFeed: networkConfig[chainId].chainlinkFeeds.USDC,
            oracleError: fp('0.0025').toString(), // 0.25%
            erc20: networkConfig[chainId].tokens.MPLmcUSDC2,
            maxTradeVolume: fp('1e6').toString(), // $1m,
            oracleTimeout: oracleTimeout(chainId, '3600').toString(), // 1 hr,
            targetName: hre.ethers.utils.formatBytes32String('USD'),
            defaultThreshold: fp('0.05').toString(), // 5%
            delayUntilDefault: bn('86400').toString(), // 24h
        },
        fp('1e-6').toString(), // revenueHiding = 0.0001%
    )
    await collateral.deployed()
    await collateral.refresh()
    expect(await collateral.status()).to.equal(CollateralStatus.SOUND)

    console.log(`Deployed Maple MPL-mcUSDC2 to ${hre.network.name} (${chainId}): ${collateral.address}`)

    assetCollDeployments.collateral.MPLmcUSDC2 = collateral.address
    deployedCollateral.push(collateral.address.toString())

    fs.writeFileSync(assetCollDeploymentFilename, JSON.stringify(assetCollDeployments, null, 2))

    console.log(`Deployed collateral to ${hre.network.name} (${chainId})
                New deployments: ${deployedCollateral}
                Deployment file: ${assetCollDeploymentFilename}`)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})