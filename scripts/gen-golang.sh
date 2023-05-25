# generate golang source files.
# reference https://docs.confluxnetwork.org/go-conflux-sdk/cfxabigen
go_project_dir=../web3pay-service

## declare an array variable
declare -a arr=("ApiWeightToken" "App" "VipCoin" "AppRegistry" "CardTracker" "CardShop")

## now loop through the above array
for name in "${arr[@]}"
do
   echo "$name"
   # ~/go/bin/cfxabigen --abi ./abi/$name.abi --pkg contract --out $go_project_dir/contract/$name.go
   ~/go/bin/abigen --abi ./abi/v2/$name.abi --pkg contract --type $name --out $go_project_dir/contract/$name.go
   # or do whatever with individual element of the array
done
# You can access them using echo "${arr[0]}", "${arr[1]}" also
echo "OK"
